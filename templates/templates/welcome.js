module.exports = (data) => {
    // Extraer el nombre del cliente. Puede venir como "Nombre Apellido"
    const nombreCliente = data.customer && data.customer.nombre ? data.customer.nombre.split(' ')[0] : 'cliente';
    const idOrden = data.orden && data.orden[0] ? data.orden[0]._id : 'N/A';

    let report = `Hola ${nombreCliente}, ya hemos ingresado tu pedido a nuestra fila de producción\n\nTu orden es la número ${idOrden}.\n`

    // Asegurarse de que 'orden' y 'productos' existen
    if (!data.orden || !data.orden[0] || !data.productos) {
        return "Error: Faltan datos de la orden o productos para generar el reporte.";
    }

    // Formatear fecha
    const fechaOriginal = data.orden[0].fecha_entrega
    const fechaFormateada = fechaOriginal.split("-").reverse().join("/")

    report += `Fecha de entrega: *${fechaFormateada}* \n\n`

    // Procesar Productos
    report += `Los productos solicitados son:\n\n`

    const repPorducts = data.productos.map((product) => {
        let talla = ""
        if (product.talla && product.talla.trim() !== "") {
            talla = ` Talla ${product.talla},`
        }
        return `- *${product.name}:*${talla} ${product.cantidad} unidades\n`
    })
    report += repPorducts.join("") // Unir con saltos de línea

    report += ` \n`

    // Verificar Descuento
    if (parseFloat(data.orden[0].pago_descuento) > 0)
        report += `- Descuento: *${data.orden[0].pago_descuento}* \n`

    // Verificar si exite abono a la orden
    const abono = parseFloat(data.orden[0].pago_abono)
    if (abono) report += `- Abono: *${abono.toFixed(2)}* \n`

    // Calcular monto restante a pagar
    const montoPendiente =
        parseFloat(data.orden[0].pago_total) -
        parseFloat(data.orden[0].pago_abono)
    if (montoPendiente > 0)
        report += `- Pendiente: *${montoPendiente.toFixed(2)}* \n`

    report += `- Total: *${data.orden[0].pago_total}* \n\n`

    report += `Te estaremos informado sobre el progreso de la fabricación de tu pedido.\n Felíz Día!!!`

    return report
}
