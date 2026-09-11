/**
 * Datos de la plantilla inicial de FAT Burger (sección 18 de la
 * especificación) - separado de seed.js para que src/scoring/validar.js
 * pueda reusar exactamente los mismos datos sin tocar la base.
 *
 * Los pesos de item son PORCENTAJES dentro de su AREA (no del sector - el
 * sector no pondera, ver schema.sql) y suman exactamente 100% en cada area.
 * Se recalcularon proporcionalmente a partir de la intensidad B/M/G
 * (1/2/3) original del Excel, así que conservan la importancia relativa
 * original de cada ítem dentro de su área.
 */

const SECTORES = [
  { nombre: 'Local Exterior' },
  { nombre: 'Local Interior Atención' },
  { nombre: 'Administración' },
  { nombre: 'Cocina' },
  { nombre: 'Depósito/Almacenamiento' },
];

const AREAS = [
  { nombre: 'Infraestructura', peso: 0.1 },
  { nombre: 'Limpieza', peso: 0.15 },
  { nombre: 'Marca', peso: 0.2 },
  { nombre: 'Atención / Operación', peso: 0.15 },
  { nombre: 'Bromatología', peso: 0.3 },
  { nombre: 'Documentación / Legales', peso: 0.1 },
];

// [sector, area, texto, peso (% dentro del area, 0..1), critico, informeInSitu]
const ITEMS = [
  ['Local Exterior', 'Infraestructura', 'Cartel exterior en condiciones', 0.041, false, false],
  ['Local Exterior', 'Infraestructura', 'Fachada en buen estado', 0.021, false, false],
  ['Local Exterior', 'Infraestructura', 'Área de ingreso peatonal limpia y segura', 0.021, false, false],
  ['Local Exterior', 'Infraestructura', 'Puerta de ingreso en buen estado', 0.02, false, false],
  ['Local Exterior', 'Infraestructura', 'Luminaria exterior funcional', 0.02, false, false],
  ['Local Exterior', 'Infraestructura', 'Vidrios sin roturas', 0.061, false, false],
  ['Local Exterior', 'Limpieza', 'Limpieza exterior general', 0.049, false, false],
  ['Local Exterior', 'Limpieza', 'Limpieza de puerta de ingreso', 0.025, false, false],
  ['Local Exterior', 'Limpieza', 'Limpieza de vidrios', 0.024, false, true],
  ['Local Exterior', 'Marca', 'Presencia de objetos ajenos a la marca no autorizados en fachada', 0.079, false, true],
  ['Local Interior Atención', 'Infraestructura', 'Mostrador en condiciones', 0.041, false, false],
  ['Local Interior Atención', 'Infraestructura', 'Paredes, pisos y aberturas', 0.041, false, false],
  ['Local Interior Atención', 'Infraestructura', 'Vidrios sin roturas interior', 0.061, false, false],
  ['Local Interior Atención', 'Infraestructura', 'Climatización funcional', 0.02, false, false],
  ['Local Interior Atención', 'Infraestructura', 'Cartelería de señalización presente', 0.041, false, false],
  ['Local Interior Atención', 'Infraestructura', 'Heladera de bebidas', 0.041, false, false],
  ['Local Interior Atención', 'Limpieza', 'Limpieza general interior', 0.049, false, false],
  ['Local Interior Atención', 'Limpieza', 'Limpieza de baños del personal', 0.073, false, true],
  ['Local Interior Atención', 'Limpieza', 'Frecuencia de retiro de residuos', 0.049, false, false],
  ['Local Interior Atención', 'Limpieza', 'Heladera de bebidas', 0.049, false, false],
  ['Local Interior Atención', 'Limpieza', 'Baños de clientes en condiciones', 0.073, false, true],
  ['Local Interior Atención', 'Marca', 'Material gráfico actualizado', 0.053, false, false],
  ['Local Interior Atención', 'Marca', 'Carta actualizada visible', 0.079, false, true],
  ['Local Interior Atención', 'Marca', 'Bebidas exhibidas correctas', 0.026, false, false],
  ['Local Interior Atención', 'Marca', 'Personal con uniforme completo', 0.053, false, false],
  ['Local Interior Atención', 'Marca', 'Presencia de objetos ajenos a la marca no autorizados en mostrador', 0.079, false, true],
  ['Local Interior Atención', 'Marca', 'Funcionan correctamente todos los medios de pago', 0.026, false, false],
  ['Local Interior Atención', 'Atención / Operación', 'Amabilidad y cordialidad del personal hacia los clientes', 0.039, false, false],
  ['Local Interior Atención', 'Atención / Operación', 'Conocimiento de la carta', 0.077, false, false],
  ['Local Interior Atención', 'Atención / Operación', 'Conocimiento de promociones', 0.077, false, false],
  ['Local Interior Atención', 'Atención / Operación', 'Correcto lineamiento de marca para la toma de pedidos', 0.077, false, false],
  ['Local Interior Atención', 'Atención / Operación', 'Uso correcto de los atajos de Whatsapp para la toma de pedidos', 0.116, false, false],
  ['Local Interior Atención', 'Atención / Operación', 'Control de pedido en carga y entrega', 0.077, false, false],
  ['Local Interior Atención', 'Atención / Operación', 'Limpieza y rotación de mesas', 0.115, false, true],
  ['Local Interior Atención', 'Atención / Operación', 'Correcto manejo del flujo de delivery', 0.077, false, false],
  ['Local Interior Atención', 'Bromatología', 'Cuentan con cofias descartables para ingresar al sector de cocina', 0.055, false, true],
  ['Local Interior Atención', 'Bromatología', 'El personal presenta correcta condiciones de higiene', 0.055, false, false],
  ['Administración', 'Marca', 'Cantidad mínima de staff exigido', 0.079, false, false],
  ['Administración', 'Documentación / Legales', 'Habilitación vigente', 0.104, true, true],
  ['Administración', 'Documentación / Legales', 'Libro de actas firmado por DT', 0.104, false, true],
  ['Administración', 'Documentación / Legales', 'Carnet de manipulación vigente', 0.104, false, false],
  ['Administración', 'Documentación / Legales', 'Certificado de desinfección', 0.103, false, false],
  ['Administración', 'Documentación / Legales', 'Certificado de limpieza de campana y ductos', 0.069, false, false],
  ['Administración', 'Documentación / Legales', 'Matafuegos en fecha y en correcto funcionamiento', 0.103, false, false],
  ['Administración', 'Documentación / Legales', 'Empleados asegurados', 0.103, false, false],
  ['Administración', 'Documentación / Legales', 'Botiquín completo y visible', 0.103, false, false],
  ['Administración', 'Documentación / Legales', 'Servicio de emergencia del local contratado y al día', 0.103, false, false],
  ['Administración', 'Documentación / Legales', 'Número de contacto de servicio de emergencia visible y de conocimiento de todos los empleados', 0.035, false, false],
  ['Administración', 'Documentación / Legales', 'Servicio de retiro de residuos contratado', 0.069, false, false],
  ['Cocina', 'Infraestructura', 'Equipos de frío suficientes y funcionando', 0.061, false, false],
  ['Cocina', 'Infraestructura', 'Rejillas con trampa anti insectos', 0.061, false, false],
  ['Cocina', 'Infraestructura', 'Burletes de heladeras en condiciones', 0.041, false, false],
  ['Cocina', 'Infraestructura', 'Plancha sin fisuras ni óxido ni deformaciones. Con bandeja de drenaje', 0.061, false, false],
  ['Cocina', 'Infraestructura', 'Freidora operativa', 0.061, false, false],
  ['Cocina', 'Infraestructura', 'Utensilios exigidos disponibles', 0.041, false, false],
  ['Cocina', 'Infraestructura', 'Toppineras en correcto estado', 0.041, false, false],
  ['Cocina', 'Infraestructura', 'Tablas de corte de colores según insumos', 0.02, false, false],
  ['Cocina', 'Infraestructura', 'Cartelería de señalización presente', 0.041, false, false],
  ['Cocina', 'Infraestructura', 'Paredes, pisos y aberturas', 0.041, false, false],
  ['Cocina', 'Infraestructura', 'Tachos de basura con tapa y en condiciones', 0.02, false, false],
  ['Cocina', 'Infraestructura', 'Tostadora de pan en óptimas condiciones', 0.041, false, false],
  ['Cocina', 'Limpieza', 'Mesadas en óptimas condiciones de trabajo', 0.073, false, true],
  ['Cocina', 'Limpieza', 'Campana y filtros en condiciones', 0.073, false, false],
  ['Cocina', 'Limpieza', 'Equipos de frío', 0.073, false, true],
  ['Cocina', 'Limpieza', 'Vajilla, tuppers, toppineras, mamaderas', 0.073, false, false],
  ['Cocina', 'Limpieza', 'Área de lavado ordenada y en condiciones', 0.049, false, false],
  ['Cocina', 'Limpieza', 'Piso seco y libre de residuos', 0.073, false, false],
  ['Cocina', 'Limpieza', 'Feteadora', 0.049, false, false],
  ['Cocina', 'Limpieza', 'Plancha', 0.073, false, true],
  ['Cocina', 'Bromatología', 'Temperatura de heladeras y freezer', 0.055, false, true],
  ['Cocina', 'Bromatología', 'FIFO y rotulación de productos', 0.055, false, true],
  ['Cocina', 'Bromatología', 'Orden en heladera (crudos abajo, cocidos arriba)', 0.055, false, true],
  ['Cocina', 'Bromatología', 'Productos en mal estado o descomposición', 0.055, false, true],
  ['Cocina', 'Bromatología', 'Verduras sanitizadas y almacenadas correctamente', 0.055, false, false],
  ['Cocina', 'Bromatología', 'Productos por encima de 20cm del suelo', 0.036, false, false],
  ['Cocina', 'Bromatología', 'Elementos de limpieza separados de alimentos', 0.055, false, true],
  ['Cocina', 'Bromatología', 'Mamaderas limpias sin residuos', 0.036, false, false],
  ['Cocina', 'Bromatología', 'Control de contaminación cruzada entre utensilios', 0.055, false, false],
  ['Cocina', 'Bromatología', 'Campana encendida durante el servicio', 0.055, false, true],
  ['Cocina', 'Bromatología', 'La verdura del servicio está en óptimas condiciones', 0.054, false, true],
  ['Cocina', 'Bromatología', 'La carne está en condiciones', 0.054, true, true],
  ['Cocina', 'Bromatología', 'Los medallones de carne están correctamente almacenados', 0.054, false, false],
  ['Cocina', 'Bromatología', 'Fecha de elaboración/vencimiento de panes', 0.054, false, false],
  ['Cocina', 'Bromatología', 'Tuppers de queso cheddar', 0.036, false, false],
  ['Cocina', 'Atención / Operación', 'Corte y armado de hamburguesas según manual', 0.115, true, true],
  ['Cocina', 'Atención / Operación', 'Cofias con cabello recogido, presencia de accesorios, uniformes reglamentario y manicura en condiciones del personal de cocina', 0.115, false, true],
  ['Cocina', 'Atención / Operación', 'Correcta presentación del producto final', 0.115, false, true],
  ['Cocina', 'Marca', 'Después de las 20hs no hay carne molida sin smashear', 0.079, true, true],
  ['Cocina', 'Marca', 'Peso de medallón, panceta', 0.079, false, true],
  ['Cocina', 'Marca', 'Corte de rodajas de tomate, cebolla y de lechuga', 0.053, false, false],
  ['Cocina', 'Marca', 'Packaging adecuado', 0.079, false, true],
  ['Cocina', 'Marca', 'Se respetan las marcas de los insumos', 0.079, true, true],
  ['Cocina', 'Marca', 'Control visual de cocción (temperatura interna carne)', 0.079, false, true],
  ['Cocina', 'Marca', 'Planilla de mermas y de cambio de aceite completas', 0.026, false, false],
  ['Cocina', 'Marca', 'Personal con uniforme completo', 0.052, false, false],
  ['Depósito/Almacenamiento', 'Infraestructura', 'Estanterías limpias y en buen estado', 0.041, false, false],
  ['Depósito/Almacenamiento', 'Limpieza', 'Sin plagas o indicios', 0.073, true, true],
  ['Depósito/Almacenamiento', 'Bromatología', 'FIFO y rotulación de productos', 0.018, false, false],
  ['Depósito/Almacenamiento', 'Bromatología', 'Separación alimentos / químicos', 0.054, false, true],
  ['Depósito/Almacenamiento', 'Bromatología', 'Control de fecha de panes y secos', 0.054, false, false],
];

const UMBRALES_CRITICOS = [
  { tipo: 'SECTOR', sector: 'Cocina', porcentaje_minimo: 0.8 },
  { tipo: 'AREA', area: 'Bromatología', porcentaje_minimo: 0.9 },
  { tipo: 'AREA', area: 'Marca', porcentaje_minimo: 0.8 },
];

const SEMAFORO = [
  { rango_min: 0, rango_max: 49, color: '#DC2626', etiqueta: 'Rojo', orden: 1 },
  { rango_min: 50, rango_max: 59, color: '#EA580C', etiqueta: 'Naranja', orden: 2 },
  { rango_min: 60, rango_max: 79, color: '#CA8A04', etiqueta: 'Amarillo', orden: 3 },
  { rango_min: 80, rango_max: 94, color: '#16A34A', etiqueta: 'Verde', orden: 4 },
  { rango_min: 95, rango_max: 100, color: '#D4AF37', etiqueta: 'Dorado', orden: 5 },
];

module.exports = { SECTORES, AREAS, ITEMS, UMBRALES_CRITICOS, SEMAFORO };
