const { Client } = require("whatsapp-web.js")
const qrcode = require("qrcode")

// Inicializamos el cliente de WhatsApp con las opciones de Puppeteer
const client = new Client({
    puppeteer: {
        headless: true, // Ejecutar en modo headless (sin interfaz gráfica)
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage", // CRUCIAL para VPS
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--single-process", // Prueba con y sin esta línea
            //            '--disable-gpu',    // Prueba con y sin esta línea
            "--window-size=1920,1080", // Establece el tamaño de la ventana
        ],
    },
})

global.whatsappReady = false // Inicialmente no está listo

client.on("qr", (qr) => {
    // Generamos el código QR para escanearlo
    qrcode.toDataURL(qr, (err, qrCodeImage) => {
        if (err) {
            console.error("Error al generar el código QR:", err)
        } else {
            global.qrCodeImage = qrCodeImage // Guardamos el QR globalmente
            console.log(
                "QR generado correctamente. Escanéalo para vincular el dispositivo."
            )
        }
    })
})

client.on("ready", () => {
    console.log("Cliente de WhatsApp listo. Ya puedes enviar mensajes.")
    global.whatsappReady = true // Indicamos que el cliente está listo
})

client.on("authenticated", () => {
    console.log("Cliente de WhatsApp autenticado correctamente.")
    global.whatsappReady = true // Aseguramos que el cliente esté listo tras la autenticación
})

client.on("auth_failure", (msg) => {
    console.error("Fallo en la autenticación:", msg)
    global.whatsappReady = false // Indicamos que el cliente no está listo
})

client.on("disconnected", (reason) => {
    console.log("Cliente de WhatsApp desconectado:", reason)
    global.whatsappReady = false // Indicamos que el cliente no está listo
    client.initialize() // Intentamos volver a inicializar el cliente
})

client.on("change_state", (state) => {
    console.log(`Estado del cliente cambiado a: ${state}`)
    if (state === "CONNECTED") {
        global.whatsappReady = true
    } else {
        global.whatsappReady = false
    }
})

client.on("message", async (msg) => {
    // console.log(`Mensaje recibido: ${msg.body}`);
    try {
        await client.sendMessage(msg.from, "Hola!")
    } catch (error) {
        console.error("Error al enviar el mensaje:", error) // Imprime el error
        console.error("Stack trace:", error.stack) // Imprime la traza de la pila
    }
})

client.on("message_ack", (msg, ack) => {
    if (ack === 3) {
        console.log(`Mensaje entregado: ${msg.body}`)
    }
})

// Iniciamos el cliente de WhatsApp
client.initialize()

// Método para mostrar el código QR en el navegador
exports.showQRCode = (req, res) => {
    if (global.qrCodeImage) {
        res.send(
            `<img src="${global.qrCodeImage}" alt="Código QR para WhatsApp">`
        )
    } else {
        res.send(
            `<h3>El código QR no está disponible aún, intenta más tarde.</h3>`
        )
    }
}

// Función para enviar mensajes
exports.sendMessage = async (req, res) => {
    const { phone, name, message } = req.body

    // Verificamos si el cliente de WhatsApp está listo
    if (!global.whatsappReady) {
        console.error("Cliente de WhatsApp no está listo.")
        return res.status(500).json({
            message:
                "El cliente de WhatsApp aún no está listo para enviar mensajes.",
            debug: {
                whatsappReady: global.whatsappReady,
                qrCodeImage: global.qrCodeImage ? true : false, // Para saber si se generó el QR
            },
        })
    }

    // Verificamos si los parámetros necesarios están presentes
    if (!phone || !message) {
        return res.status(400).json({
            message: "Faltan parámetros: número de teléfono y/o mensaje.",
        })
    }

    try {
        // Añadir un pequeño retraso antes de enviar el mensaje
        await new Promise((resolve) => setTimeout(resolve, 2000))

        const formattedPhone = `${phone}@c.us` // Formateamos el número de teléfono
        const fullMessage = `Hola ${name}, ${message}` // Componemos el mensaje con el nombre

        // Enviamos el mensaje usando el cliente de WhatsApp
        await client.sendMessage(formattedPhone, fullMessage)
        console.log(`Mensaje enviado a ${phone}: ${fullMessage}`)

        res.status(200).json({
            message: `Mensaje enviado exitosamente a ${name} (${phone})`,
        })
    } catch (error) {
        console.error("Error al enviar el mensaje:", error)
        res.status(500).json({
            message: "Error al enviar el mensaje",
            error: error.toString(),
        })
    }
}
