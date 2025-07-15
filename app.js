require("dotenv").config(); // Cargar variables de entorno al principio

const express = require("express");
const path = require("path");
// require("dotenv").config(); // Esta importación está duplicada, la eliminamos
const bodyParser = require("body-parser");
const app = express();
const routes = require("./routes/index");

// *** Importar la nueva función de inicialización ***
const { initializeAllClientsFromSessions } = require("./controllers/whatsappController");

// Servir archivos estáticos desde la carpeta "public"
app.use(express.static(path.join(__dirname, "public")));

// Middleware para parsear el cuerpo de las peticiones
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Usar las rutas definidas en index.js
app.use("/", routes);

const PORT = process.env.PORT || 3001;
// const URL = process.env.APP_URL || "http://localhost:"; // Esta variable se define pero no se usa, puedes mantenerla o eliminarla si no la necesitas en otro lado.

// Función asíncrona para iniciar la aplicación, incluyendo la inicialización de clientes
const startApplication = async () => {
    // *** Llamar a la función para inicializar clientes desde sesiones guardadas ***
    // Esto disparará el proceso de carga en segundo plano.
    // NO usamos 'await' aquí para que el servidor HTTP empiece a escuchar inmediatamente
    // mientras la inicialización de WhatsApp ocurre de forma asíncrona.
    console.log("Iniciando proceso de carga de sesiones de WhatsApp guardadas...");
    initializeAllClientsFromSessions()
        .then(() => console.log("Proceso de inicialización de sesiones completado (se dispararon las inicializaciones encontradas)."))
        .catch(error => console.error("Error durante la carga de sesiones al inicio:", error));

    // Iniciar el servidor HTTP
    app.listen(PORT, () => {
        console.log(`Servidor corriendo en el puerto ${PORT}`);
        // Puedes añadir la URL aquí si la variable URL se usa:
        // console.log(`Application URL: ${URL}${PORT}`);
    });
};

// *** Llamar a la función principal de inicio de la aplicación ***
startApplication();