module.exports = (data) => {
    let report = `Hola ${data.first_name}, ya hemos ingresado tu pedido a nuestra fila de producción\n\n tu Orden es la número ${data.id_orden}, \n`

    // Formatear fecha
    const fechaOriginal = data.data.object.orden[0].fecha_entrega
    const fechaFormateada = fechaOriginal.split("-").reverse().join("/")

    report += `Fecha de entrega: *${fechaFormateada}* \n\n`

    // Procesar Productos
    report += `Los productos solicitados son:\n\n`

    const repPorducts = data.data.object.productos.map((product) => {
        let talla = ""
        if (product.talla != "") {
            talla = ` Talla ${product.talla},`
        }
        return `- *${product.name}:*${talla} ${product.cantidad} unidades\n`
    })
    report += repPorducts.join("") // Unir con saltos de línea

    report += ` \n`

    // Verificar Descuento
    if (parseFloat(data.data.object.orden[0].pago_descuento) > 0)
        report += `- Descuento: *${data.data.object.orden[0].pago_descuento}* \n`

    // Verificar si exite abono a la orden
    const abono = parseFloat(data.data.object.orden[0].pago_abono)
    if (abono) report += `- Abono: *${abono.toFixed(2)}* \n`

    // Calcular monto restante a pagar
    const montoPendiente =
        parseFloat(data.data.object.orden[0].pago_total) -
        parseFloat(data.data.object.orden[0].pago_abono)
    if (montoPendiente > 0)
        report += `- Pendiente: *${montoPendiente.toFixed(2)}* \n`

    report += `- Total: *${data.data.object.orden[0].pago_total}* \n\n`

    report += `Te estaremos informado sobre el progreso de la fabricación de tu pedido.\n Felíz Día!!!`

    return report
}
