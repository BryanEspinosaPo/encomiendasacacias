// Encomiendas Acacias — servidor (Node.js + Express + PostgreSQL)
"use strict";
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === "production" || !!process.env.RAILWAY_ENVIRONMENT;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Falta la variable DATABASE_URL (en Railway: ${{Postgres.DATABASE_URL}}).");
  process.exit(1);
}
let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  JWT_SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("AVISO: falta JWT_SECRET. Se usa uno temporal: las sesiones se cierran en cada reinicio.");
}

const needsSsl = process.env.PGSSLMODE === "require" || /rlwy\.net|amazonaws|supabase|neon\.tech/.test(DATABASE_URL);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: needsSsl ? { rejectUnauthorized: false } : false, max: 10 });

const ESTADOS = ["programado", "recogido", "en_ruta", "entregado", "cancelado"];
const pad = (n, w) => String(n).padStart(w, "0");
const guiaDe = id => "EA-" + pad(id, 6);
const clienteDe = id => "C" + pad(id, 4);
const idDeGuia = g => { const m = /^EA-(\d{1,9})$/.exec(String(g || "")); return m ? Number(m[1]) : null; };

/* ---------------- Base de datos ---------------- */
async function migrar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      usuario VARCHAR(40) UNIQUE NOT NULL,
      nombre VARCHAR(60) NOT NULL,
      password_hash TEXT NOT NULL,
      rol VARCHAR(15) NOT NULL CHECK (rol IN ('admin','colaborador')),
      activo BOOLEAN NOT NULL DEFAULT TRUE,
      creado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nombre VARCHAR(25) NOT NULL,
      cc BIGINT NOT NULL,
      celular VARCHAR(15) UNIQUE NOT NULL,
      creado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS servicios (
      id SERIAL PRIMARY KEY,
      cliente_id INT NOT NULL REFERENCES clientes(id),
      fecha DATE NOT NULL,
      hora_recogida TIME,
      hora_entrega TIME,
      total INT NOT NULL DEFAULT 0,
      estado VARCHAR(15) NOT NULL DEFAULT 'programado'
        CHECK (estado IN ('programado','recogido','en_ruta','entregado','cancelado')),
      motivo_cancelacion VARCHAR(120),
      historial JSONB NOT NULL DEFAULT '[]'::jsonb,
      creado_por INT REFERENCES usuarios(id),
      creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
      entregado_en TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS servicios_fecha_idx ON servicios(fecha);
    CREATE INDEX IF NOT EXISTS servicios_estado_idx ON servicios(estado);
    CREATE TABLE IF NOT EXISTS servicio_items (
      id SERIAL PRIMARY KEY,
      servicio_id INT NOT NULL REFERENCES servicios(id) ON DELETE CASCADE,
      descripcion VARCHAR(100) NOT NULL,
      peso INT NOT NULL DEFAULT 0,
      tamano VARCHAR(25) NOT NULL,
      valor INT NOT NULL DEFAULT 0,
      origen VARCHAR(60) NOT NULL,
      destino VARCHAR(60) NOT NULL
    );
    CREATE INDEX IF NOT EXISTS servicio_items_servicio_idx ON servicio_items(servicio_id);
    CREATE TABLE IF NOT EXISTS reportes (
      fecha DATE PRIMARY KEY,
      gastos INT NOT NULL DEFAULT 0,
      sueldos INT NOT NULL DEFAULT 0,
      credito INT NOT NULL DEFAULT 0,
      notas VARCHAR(300),
      auto JSONB,
      neto INT,
      generado TIMESTAMPTZ,
      actualizado TIMESTAMPTZ NOT NULL DEFAULT now(),
      actualizado_por INT REFERENCES usuarios(id)
    );
  `);
  const limpiar = v => String(v ?? "").trim().replace(/^["']|["']$/g, "");
  const usuario = (limpiar(process.env.ADMIN_USUARIO) || "admin").toLowerCase();
  const nombre = (limpiar(process.env.ADMIN_NOMBRE) || "Administrador").slice(0, 60);
  let clave = limpiar(process.env.ADMIN_PASSWORD);
  const reset = /^(1|true|si|sí|yes)$/i.test(limpiar(process.env.ADMIN_RESET));

  const { rows } = await pool.query("SELECT count(*)::int AS n FROM usuarios");
  if (rows[0].n === 0 || reset) {
    if (reset || !clave) {
      // Clave temporal fácil de leer (sin 0/O, 1/l/I) para copiarla de los logs
      const abc = "abcdefghjkmnpqrstuvwxyz23456789";
      clave = Array.from(crypto.randomBytes(8), b => abc[b % abc.length]).join("");
    }
    await pool.query(
      `INSERT INTO usuarios (usuario, nombre, password_hash, rol, activo) VALUES ($1,$2,$3,'admin',TRUE)
       ON CONFLICT (usuario) DO UPDATE SET password_hash=EXCLUDED.password_hash, rol='admin', activo=TRUE`,
      [usuario, nombre, await bcrypt.hash(clave, 10)]
    );
    console.log("==================================================");
    console.log(`ACCESO DE ADMINISTRADOR  usuario: ${usuario}   clave: ${clave}`);
    console.log("Entra con estos datos y cambia la clave en Usuarios.");
    if (reset) console.log("Luego borra la variable ADMIN_RESET en Railway.");
    console.log("==================================================");
  }
  const { rows: admins } = await pool.query("SELECT usuario, activo FROM usuarios WHERE rol='admin' ORDER BY id");
  console.log("Administradores:", admins.map(a => a.usuario + (a.activo ? "" : " (desactivado)")).join(", ") || "ninguno");
}

/* ---------------- App ---------------- */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin"
  });
  next();
});

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

/* --- sesión --- */
const COOKIE = "ea_sesion";
function firmar(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: "7d" });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 7 * 24 * 3600 * 1000 });
}
const auth = wrap(async (req, res, next) => {
  const token = req.cookies[COOKIE];
  if (!token) fail(401, "Inicia sesión.");
  let data;
  try { data = jwt.verify(token, JWT_SECRET); } catch { fail(401, "Tu sesión venció. Inicia sesión de nuevo."); }
  const { rows } = await pool.query("SELECT id, usuario, nombre, rol, activo FROM usuarios WHERE id=$1", [data.uid]);
  const u = rows[0];
  if (!u || !u.activo) { res.clearCookie(COOKIE); fail(401, "Tu usuario está desactivado. Habla con el administrador."); }
  req.user = u;
  next();
});
const soloAdmin = (req, res, next) => (req.user.rol === "admin" ? next() : next(new HttpError(403, "Solo el administrador puede hacer esto.")));

/* --- límite de intentos de inicio de sesión --- */
const intentos = new Map();
function limitarLogin(req) {
  const k = req.ip, now = Date.now();
  const r = intentos.get(k) || { n: 0, t: now };
  if (now - r.t > 15 * 60 * 1000) { r.n = 0; r.t = now; }
  r.n++; intentos.set(k, r);
  if (r.n > 10) fail(429, "Demasiados intentos. Espera 15 minutos.");
}

/* --- validación --- */
const txt = (v, max, campo, req = true) => {
  const s = String(v ?? "").trim();
  if (req && !s) fail(400, `Falta ${campo}.`);
  if (s.length > max) fail(400, `${campo} admite máximo ${max} caracteres.`);
  return s;
};
const entero = (v, campo) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 2_000_000_000) fail(400, `${campo} no es válido.`);
  return Math.round(n);
};
const digitos = (v, min, max, campo) => {
  const s = String(v ?? "").replace(/\D/g, "");
  if (s.length < min || s.length > max) fail(400, `${campo} no es válido.`);
  return s;
};
const fechaOk = (v, campo) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v || ""))) fail(400, `${campo} no es válida.`); return v; };
const horaOk = (v, campo) => { if (!v) return null; if (!/^\d{2}:\d{2}$/.test(String(v))) fail(400, `${campo} no es válida.`); return v; };

/* --- lectura de servicios --- */
const SQL_SERVICIOS = `
  SELECT s.id, s.fecha::text AS fecha,
         to_char(s.hora_recogida,'HH24:MI') AS hora_recogida,
         to_char(s.hora_entrega,'HH24:MI') AS hora_entrega,
         s.total, s.estado, s.motivo_cancelacion, s.historial, s.creado_en, s.entregado_en,
         c.id AS cliente_id, c.nombre, c.cc::text AS cc, c.celular,
         u.nombre AS creado_por_nombre,
         COALESCE((SELECT json_agg(json_build_object(
             'descripcion', i.descripcion, 'peso', i.peso, 'tamano', i.tamano,
             'valor', i.valor, 'origen', i.origen, 'destino', i.destino) ORDER BY i.id)
           FROM servicio_items i WHERE i.servicio_id = s.id), '[]'::json) AS items
  FROM servicios s
  JOIN clientes c ON c.id = s.cliente_id
  LEFT JOIN usuarios u ON u.id = s.creado_por`;
const mapServicio = r => ({
  id: guiaDe(r.id), guia: guiaDe(r.id), num: r.id,
  clienteId: clienteDe(r.cliente_id),
  cliente: { nombre: r.nombre, cc: r.cc, celular: r.celular },
  fecha: r.fecha, horaRecogida: r.hora_recogida || "", horaEntrega: r.hora_entrega || "",
  items: r.items, total: r.total, estado: r.estado,
  motivoCancelacion: r.motivo_cancelacion || null,
  historial: r.historial || [],
  creadoEn: r.creado_en, entregadoEn: r.entregado_en, creadoPor: r.creado_por_nombre || null
});
async function servicioPorId(id, db = pool) {
  const { rows } = await db.query(SQL_SERVICIOS + " WHERE s.id=$1", [id]);
  return rows[0] ? mapServicio(rows[0]) : null;
}

/* ---------------- Rutas ---------------- */
app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/api/login", wrap(async (req, res) => {
  limitarLogin(req);
  const usuario = String(req.body?.usuario || "").trim().toLowerCase();
  const clave = String(req.body?.password || "");
  const { rows } = await pool.query("SELECT * FROM usuarios WHERE usuario=$1", [usuario]);
  const u = rows[0];
  if (!u) { console.warn(`Login fallido: el usuario "${usuario}" no existe.`); fail(401, "Usuario o contraseña incorrectos."); }
  if (!(await bcrypt.compare(clave, u.password_hash))) { console.warn(`Login fallido: clave incorrecta para "${usuario}" (${clave.length} caracteres escritos).`); fail(401, "Usuario o contraseña incorrectos."); }
  if (!u.activo) fail(403, "Tu usuario está desactivado. Habla con el administrador.");
  intentos.delete(req.ip);
  firmar(res, u);
  res.json({ id: u.id, usuario: u.usuario, nombre: u.nombre, rol: u.rol });
}));

app.post("/api/logout", (req, res) => { res.clearCookie(COOKIE); res.json({ ok: true }); });

app.get("/api/me", auth, (req, res) => {
  const { id, usuario, nombre, rol } = req.user;
  res.json({ id, usuario, nombre, rol });
});

app.post("/api/me/password", auth, wrap(async (req, res) => {
  const nueva = String(req.body?.nueva || "");
  if (nueva.length < 6) fail(400, "La nueva contraseña debe tener al menos 6 caracteres.");
  const { rows } = await pool.query("SELECT password_hash FROM usuarios WHERE id=$1", [req.user.id]);
  if (!(await bcrypt.compare(String(req.body?.actual || ""), rows[0].password_hash))) fail(400, "La contraseña actual no coincide.");
  await pool.query("UPDATE usuarios SET password_hash=$1 WHERE id=$2", [await bcrypt.hash(nueva, 10), req.user.id]);
  res.json({ ok: true });
}));

/* --- clientes --- */
app.get("/api/clientes", auth, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT id, nombre, cc::text AS cc, celular, creado FROM clientes ORDER BY id DESC LIMIT 5000");
  res.json(rows.map(c => ({ id: clienteDe(c.id), num: c.id, nombre: c.nombre, cc: c.cc, celular: c.celular, creadoEn: c.creado })));
}));

/* --- servicios --- */
app.get("/api/servicios", auth, wrap(async (req, res) => {
  let desde = req.query.desde;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(desde || ""))) {
    desde = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  }
  const { rows } = await pool.query(
    SQL_SERVICIOS + ` WHERE s.fecha >= $1::date
       OR s.entregado_en >= ($1::date - 1)
       OR s.estado NOT IN ('entregado','cancelado')
     ORDER BY s.fecha DESC, s.hora_entrega NULLS LAST LIMIT 5000`, [desde]);
  res.json(rows.map(mapServicio));
}));

app.post("/api/servicios", auth, wrap(async (req, res) => {
  const b = req.body || {};
  const celular = digitos(b.cliente?.celular, 7, 15, "El celular");
  const nombre = txt(b.cliente?.nombre, 25, "El nombre del cliente");
  const cc = digitos(b.cliente?.cc, 1, 12, "La C.C.");
  const fecha = fechaOk(b.fecha, "La fecha del servicio");
  const hr = horaOk(b.horaRecogida, "La hora de recogida");
  const he = horaOk(b.horaEntrega, "La hora de entrega");
  if (hr && he && he < hr) fail(400, "La hora de entrega no puede ser antes de la hora de recogida.");
  if (!Array.isArray(b.items) || b.items.length === 0) fail(400, "Agrega al menos un producto.");
  if (b.items.length > 50) fail(400, "Máximo 50 productos por servicio.");
  const items = b.items.map((i, k) => ({
    descripcion: txt(i.descripcion, 100, `La descripción del producto ${k + 1}`),
    peso: entero(i.peso, `El peso del producto ${k + 1}`),
    tamano: txt(i.tamano, 25, `El tamaño del producto ${k + 1}`),
    valor: entero(i.valor, `El valor del producto ${k + 1}`),
    origen: txt(i.origen, 60, `El origen del producto ${k + 1}`),
    destino: txt(i.destino, 60, `El destino del producto ${k + 1}`)
  }));
  const total = items.reduce((a, i) => a + i.valor, 0);

  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const cli = await db.query(
      `INSERT INTO clientes (nombre, cc, celular) VALUES ($1,$2,$3)
       ON CONFLICT (celular) DO UPDATE SET nombre=EXCLUDED.nombre, cc=EXCLUDED.cc
       RETURNING id`, [nombre, cc, celular]);
    const historial = [{ estado: "programado", at: new Date().toISOString(), por: req.user.nombre }];
    const sv = await db.query(
      `INSERT INTO servicios (cliente_id, fecha, hora_recogida, hora_entrega, total, historial, creado_por)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [cli.rows[0].id, fecha, hr, he, total, JSON.stringify(historial), req.user.id]);
    const sid = sv.rows[0].id;
    for (const i of items) {
      await db.query(
        `INSERT INTO servicio_items (servicio_id, descripcion, peso, tamano, valor, origen, destino)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`, [sid, i.descripcion, i.peso, i.tamano, i.valor, i.origen, i.destino]);
    }
    await db.query("COMMIT");
    res.status(201).json(await servicioPorId(sid));
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    db.release();
  }
}));

app.patch("/api/servicios/:guia/estado", auth, wrap(async (req, res) => {
  const id = idDeGuia(req.params.guia);
  if (!id) fail(404, "Guía no encontrada.");
  const estado = String(req.body?.estado || "");
  if (!ESTADOS.includes(estado)) fail(400, "Estado no válido.");
  const motivo = estado === "cancelado" ? txt(req.body?.motivo, 120, "El motivo", false) || null : null;
  const evento = { estado, at: new Date().toISOString(), por: req.user.nombre, ...(motivo ? { motivo } : {}) };
  const { rowCount } = await pool.query(
    `UPDATE servicios SET
       estado = $2::varchar,
       historial = historial || $3::jsonb,
       entregado_en = CASE WHEN $2::varchar = 'entregado' THEN now() ELSE NULL END,
       motivo_cancelacion = CASE WHEN $2::varchar = 'cancelado' THEN $4::varchar ELSE motivo_cancelacion END
     WHERE id = $1`, [id, estado, JSON.stringify([evento]), motivo]);
  if (!rowCount) fail(404, "Guía no encontrada.");
  res.json(await servicioPorId(id));
}));

/* --- reporte diario (solo admin) --- */
app.get("/api/reportes/:fecha", auth, soloAdmin, wrap(async (req, res) => {
  const fecha = fechaOk(req.params.fecha, "La fecha");
  const { rows } = await pool.query("SELECT fecha::text AS fecha, gastos, sueldos, credito, notas, auto, neto, generado, actualizado FROM reportes WHERE fecha=$1", [fecha]);
  res.json(rows[0] || null);
}));

app.put("/api/reportes/:fecha", auth, soloAdmin, wrap(async (req, res) => {
  const fecha = fechaOk(req.params.fecha, "La fecha");
  const b = req.body || {};
  const gastos = entero(b.gastos || 0, "Gastos"), sueldos = entero(b.sueldos || 0, "Sueldos"), credito = entero(b.credito || 0, "Crédito carro");
  const notas = txt(b.notas, 300, "Las notas", false) || null;
  const auto = b.auto && typeof b.auto === "object" ? b.auto : null;
  const ingresos = auto ? entero(auto.ingresos || 0, "Ingresos") : 0;
  const neto = ingresos - gastos - sueldos - credito;
  const { rows } = await pool.query(
    `INSERT INTO reportes (fecha, gastos, sueldos, credito, notas, auto, neto, generado, actualizado, actualizado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::boolean THEN now() END, now(), $9)
     ON CONFLICT (fecha) DO UPDATE SET gastos=$2, sueldos=$3, credito=$4, notas=$5, auto=$6, neto=$7,
       generado = CASE WHEN $8::boolean THEN now() ELSE reportes.generado END, actualizado=now(), actualizado_por=$9
     RETURNING fecha::text AS fecha, gastos, sueldos, credito, notas, auto, neto, generado, actualizado`,
    [fecha, gastos, sueldos, credito, notas, auto, neto, !!b.generar, req.user.id]);
  res.json(rows[0]);
}));

/* --- usuarios (solo admin) --- */
app.get("/api/usuarios", auth, soloAdmin, wrap(async (req, res) => {
  const { rows } = await pool.query("SELECT id, usuario, nombre, rol, activo, creado FROM usuarios ORDER BY rol, nombre");
  res.json(rows);
}));

app.post("/api/usuarios", auth, soloAdmin, wrap(async (req, res) => {
  const usuario = txt(req.body?.usuario, 40, "El usuario").toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) fail(400, "El usuario solo puede tener letras, números, punto, guion y guion bajo (mínimo 3).");
  const nombre = txt(req.body?.nombre, 60, "El nombre");
  const rol = req.body?.rol === "admin" ? "admin" : "colaborador";
  const clave = String(req.body?.password || "");
  if (clave.length < 6) fail(400, "La contraseña debe tener al menos 6 caracteres.");
  try {
    const { rows } = await pool.query(
      "INSERT INTO usuarios (usuario, nombre, password_hash, rol) VALUES ($1,$2,$3,$4) RETURNING id, usuario, nombre, rol, activo, creado",
      [usuario, nombre, await bcrypt.hash(clave, 10), rol]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === "23505") fail(409, "Ese nombre de usuario ya existe.");
    throw e;
  }
}));

app.patch("/api/usuarios/:id", auth, soloAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) fail(404, "Usuario no encontrado.");
  const b = req.body || {};
  if (id === req.user.id && (b.activo === false || b.rol === "colaborador")) fail(400, "No puedes desactivarte ni quitarte el rol de administrador.");
  const sets = [], vals = [id];
  if (typeof b.activo === "boolean") { vals.push(b.activo); sets.push(`activo=$${vals.length}`); }
  if (b.rol === "admin" || b.rol === "colaborador") { vals.push(b.rol); sets.push(`rol=$${vals.length}`); }
  if (b.password) {
    if (String(b.password).length < 6) fail(400, "La contraseña debe tener al menos 6 caracteres.");
    vals.push(await bcrypt.hash(String(b.password), 10)); sets.push(`password_hash=$${vals.length}`);
  }
  if (!sets.length) fail(400, "No hay cambios.");
  const { rows } = await pool.query(`UPDATE usuarios SET ${sets.join(", ")} WHERE id=$1 RETURNING id, usuario, nombre, rol, activo, creado`, vals);
  if (!rows[0]) fail(404, "Usuario no encontrado.");
  res.json(rows[0]);
}));

/* --- archivos de la app --- */
app.use(express.static(path.join(__dirname, "public"), { maxAge: PROD ? "1h" : 0 }));
app.use("/api", (req, res) => res.status(404).json({ error: "Ruta no encontrada." }));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* --- errores --- */
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Datos mal formados." });
  console.error(err);
  res.status(500).json({ error: "Error del servidor. Intenta de nuevo." });
});

migrar()
  .then(() => app.listen(PORT, () => console.log(`Encomiendas Acacias escuchando en el puerto ${PORT}`)))
  .catch(e => { console.error("No se pudo preparar la base de datos:", e); process.exit(1); });