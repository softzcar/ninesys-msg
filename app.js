require("dotenv").config()

const express = require("express")
const path = require("path")
require("dotenv").config()
const bodyParser = require("body-parser")
const app = express()
const routes = require("./routes/index")

// Servir archivos estáticos desde la carpeta "public"
app.use(express.static(path.join(__dirname, "public")))

app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json())

app.use("/", routes)

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`)
})
