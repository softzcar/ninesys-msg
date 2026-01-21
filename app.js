require("dotenv").config();

// Aumentar el límite de listeners
process.setMaxListeners(0);

const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const app = express();
const routes = require("./routes/index");

// *** WebSocket initialization ***
const { initWebSocket } = require("./websocket");

// *** Importar la función de inicialización de sesiones ***
const { initializeAllClientsFromSessions } = require("./controllers/whatsappController");

// Servir archivos estáticos desde la carpeta "public"
app.use(express.static(path.join(__dirname, "public")));

// Middleware para parsear el cuerpo de las peticiones
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Usar las rutas definidas en index.js
app.use("/", routes);

const PORT = process.env.PORT || 3001;

// Crear servidor HTTP
const server = http.createServer(app);

// Inicializar WebSocket
const io = initWebSocket(server);

// Función asíncrona para iniciar la aplicación
const startApplication = async () => {
    console.log("Iniciando proceso de carga de sesiones de WhatsApp guardadas...");
    initializeAllClientsFromSessions()
        .then(() => console.log("Proceso de inicialización de sesiones completado."))
        .catch(error => console.error("Error durante la carga de sesiones al inicio:", error));

    // Iniciar el servidor HTTP (ahora con WebSocket)
    server.listen(PORT, () => {
        console.log(`Servidor corriendo en el puerto ${PORT} (HTTP + WebSocket)`);
    });
};

// Llamar a la función principal de inicio
startApplication();
