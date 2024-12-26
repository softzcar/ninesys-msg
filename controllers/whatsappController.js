const { Client, LocalAuth } = require("whatsapp-web.js")
const qrcode = require("qrcode")

// Inicializamos el cliente de WhatsApp con persistencia de sesión
const client = new Client({
    authStrategy: new LocalAuth(), // Esto asegura que la sesión se persista
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
    global.qrCodeImage = null // Eliminamos el QR ya que el cliente está listo
})

client.on("authenticated", () => {
    console.log("Cliente de WhatsApp autenticado correctamente.")
})

client.on("auth_failure", (msg) => {
    console.error("Fallo en la autenticación:", msg)
    global.whatsappReady = false // Indicamos que el cliente no está listo
})

client.on("disconnected", (reason) => {
    console.log("Cliente de WhatsApp desconectado:", reason)
    global.whatsappReady = false // Indicamos que el cliente no está listo
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
