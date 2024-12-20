// Importar el controlador
async function login(event) {
    event.preventDefault() // Evita recargar la página

    const username = document.getElementById("username").value
    const password = document.getElementById("password").value
    const loginButton = document.getElementById("loginButton")
    const msgElement = document.getElementById("msg")
    msgElement.innerHTML = ""
    document.getElementById("img-qr").src = "/noqr"

    // Desactiva el botón para evitar múltiples envíos
    loginButton.disabled = true
    loginButton.textContent = "Enviando..."

    // Convertir los datos a formato `x-www-form-urlencoded`
    const formData = new URLSearchParams()
    formData.append("username", username)
    formData.append("password", password)

    try {
        const response = await fetch(
            "https://api.nineteengreen.com/verify-credentials",
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                body: formData.toString(),
            }
        )

        const data = await response.json()
        console.log("Respuesta de login:", data)

        if (response.ok && data.access) {
            // Guardar el token en LocalStorage
            localStorage.setItem("token", data.token)

            // Mostrar el código QR usando el controlador
            // document.getElementById("img-qr").src = "/qr"

            document.getElementById("img-qr").src = "/qr"
        } else {
            msgElement.textContent = data.msg || "Credenciales incorrectas."
        }
    } catch (error) {
        console.error("Error en el proceso de login:", error)
        msgElement.textContent = "Ocurrió un error. Intenta nuevamente."
    } finally {
        // Habilitar el botón de nuevo
        loginButton.disabled = false
        loginButton.textContent = "Enviar"
    }
}

document.getElementById("loginForm").addEventListener("submit", login)
/* async function fetchQr() {
    const token = localStorage.getItem("token")

    if (!token) {
        document.getElementById("msg").innerHTML =
            "No tienes permiso para acceder al código QR."
        return
    }

    try {
        const response = await fetch("/qr")

        if (response.ok) {
            // Mostrar el contenido del código QR
            const qrData = await response.json()
            document.getElementById(
                "msg"
            ).innerHTML = `<img src="${qrData.qrCodeImage}" alt="Código QR para WhatsApp">`
        } else {
            document.getElementById("msg").innerHTML =
                "Acceso denegado al código QR."
        }
    } catch (error) {
        document.getElementById("msg").innerHTML =
            "Error al obtener el código QR."
    }
} */

// Agregar el event listener al formulario
