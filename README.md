# Encomiendas Acacias

App web de logística: servicios con guía y recibo para WhatsApp, tablero por hora de entrega, clientes, reporte diario y usuarios (administrador y colaborador).

**Tecnología:** Node.js 18+ · Express · PostgreSQL · HTML/CSS/JavaScript

```
encomiendas-railway/
├── server.js          ← API, inicio de sesión y creación automática de tablas
├── package.json
├── .env.example       ← variables de entorno de ejemplo
└── public/
    └── index.html     ← la aplicación (interfaz)
```

## Desplegar en Railway

1. **Sube el proyecto a GitHub.** Crea un repositorio y sube esta carpeta (el `.gitignore` ya excluye `node_modules` y `.env`).
2. **Crea el proyecto en Railway:** *New Project → Deploy from GitHub repo* y elige el repositorio.
3. **Agrega la base de datos:** dentro del proyecto, *+ Create → Database → PostgreSQL*.
4. **Configura las variables** en el servicio de la app (pestaña *Variables*):

   | Variable | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `JWT_SECRET` | un texto largo y aleatorio (por ejemplo 40 letras y números) |
   | `ADMIN_USUARIO` | `admin` (o el que quieras) |
   | `ADMIN_PASSWORD` | la contraseña del primer administrador |
   | `ADMIN_NOMBRE` | tu nombre |
   | `NODE_ENV` | `production` |

5. **Publica la URL:** en *Settings → Networking* pulsa *Generate Domain*. Queda algo como `encomiendas-acacias.up.railway.app`.
6. Abre la URL e ingresa con `ADMIN_USUARIO` / `ADMIN_PASSWORD`. Las tablas se crean solas al primer arranque.
7. En **Usuarios** crea las cuentas de tus colaboradores.

> `ADMIN_*` solo se usa la primera vez (cuando no hay usuarios). Después cambia tu contraseña desde **Usuarios → Cambiar mi contraseña**.

Alternativa sin GitHub: instala la CLI (`npm i -g @railway/cli`), y en esta carpeta ejecuta `railway login`, `railway init` y `railway up`.

## Probar en tu computador

```bash
npm install
cp .env.example .env      # y edita los valores
# carga las variables y arranca (Mac/Linux):
export $(grep -v '^#' .env | xargs) && npm start
```

Abre http://localhost:3000

## Base de datos

| Tabla | Contenido |
|---|---|
| `usuarios` | id, usuario, nombre, contraseña (cifrada con bcrypt), rol (`admin` / `colaborador`), activo |
| `clientes` | id autoincremental (se muestra C0001), nombre VARCHAR(25), cc BIGINT, celular (único) |
| `servicios` | id autoincremental (guía EA-000001), cliente, fecha, hora recogida, hora entrega, total, estado, historial |
| `servicio_items` | descripción VARCHAR(100), peso INT, tamaño VARCHAR(25), valor, origen, destino |
| `reportes` | un registro por día: gastos, sueldos, crédito carro, notas, totales automáticos y balance |

La C.C. se guarda como `BIGINT` porque las cédulas de 10 dígitos no caben en `INT`.

## Permisos

- **Administrador:** todo, más el reporte diario y la gestión de usuarios.
- **Colaborador:** registra servicios y clientes, cambia estados (incluido Cancelado) y envía guías por WhatsApp.
- Un usuario desactivado no puede entrar y su sesión abierta se cierra en la siguiente acción.

## WhatsApp

- **En celular:** "Enviar imagen por WhatsApp" abre el menú de compartir del teléfono con la imagen del recibo. Eliges WhatsApp y el contacto.
- **En computador:** la imagen se copia y se descarga, y se abre el chat del cliente para pegarla (Ctrl+V).
- Para enviar mensajes de forma 100 % automática se necesita la API de WhatsApp Business (servicio de pago de Meta).

## Respaldo

En Railway, el servicio PostgreSQL tiene la pestaña *Backups*. Actívala para no perder información.
