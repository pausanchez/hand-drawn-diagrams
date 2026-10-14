# Hand-drawn diagrams · Skill para Claude

Una skill para Claude que dibuja **diagramas de flujo, workflows, flujos de pantallas y wireframes con aspecto de pizarra hecho a mano**: trazos irregulares, rellenos rayados y letra manuscrita.

Le describes la idea a Claude y él escribe una especificación en JSON. La skill la convierte en un SVG y un PNG, y la maquetación es automática: nunca hay que calcular coordenadas.

![Sistema de captación de propietarios forestales](skills/hand-drawn-diagrams/examples/forest-owners.png)

## Ejemplos

### Proceso con bucles y fases
Un sistema para que una Asociación de Propietarios Forestales sume a los propietarios de las fincas colindantes. Usa grupos para las fases, una decisión y dos bucles: uno de reintento (en rojo) y otro de crecimiento (en verde).

![Proceso forestal](skills/hand-drawn-diagrams/examples/forest-owners.png)
→ [`forest-owners.json`](skills/hand-drawn-diagrams/examples/forest-owners.json)

> **Prompt:** *"Necesito un draft visual de una idea: un sistema para que las Asociaciones de Propietarios Forestales consigan más propietarios de pequeñas fincas aledañas"*

### Flujo de pantallas (onboarding)
Pantallas de móvil enlazadas desde sus botones, como en un prototipo. Incluye un rombo de decisión, un camino alternativo y una nota.

![Onboarding](skills/hand-drawn-diagrams/examples/onboarding.png)
→ [`onboarding.json`](skills/hand-drawn-diagrams/examples/onboarding.json)

### Workflow con swimlanes
Un proceso editorial con un grupo por equipo y un bucle de "cambios".

![Workflow](skills/hand-drawn-diagrams/examples/workflow.png)
→ [`workflow.json`](skills/hand-drawn-diagrams/examples/workflow.json)

### Wireframe de escritorio
Una sola pantalla con navegador, filtros, mapa destacado, ficha y botones de acción.

<img src="skills/hand-drawn-diagrams/examples/wireframe.png" width="420" alt="Wireframe">

→ [`wireframe.json`](skills/hand-drawn-diagrams/examples/wireframe.json)

## Instalación

### Claude Code
Ejecuta estos dos comandos **por separado**, uno detrás de otro. Si los pegas juntos, Claude Code los toma como un solo comando y no instala nada.

1. Añade el marketplace:
   ```
   /plugin marketplace add pausanchez/hand-drawn-diagrams
   ```
2. Instala el plugin:
   ```
   /plugin install hand-drawn-diagrams@pausanchez
   ```

Para exportar a PNG, ejecuta una vez `npx playwright install chromium`.

### Claude.ai / app de Claude
1. Descarga la carpeta [`skills/hand-drawn-diagrams`](skills/hand-drawn-diagrams) y comprímela en un `.zip`. Puedes usar *Code → Download ZIP* y quedarte solo con esa carpeta.
2. Ve a **Ajustes → Capacidades → Skills** y sube el zip.

### A mano
Copia `skills/hand-drawn-diagrams` en `~/.claude/skills/`.

La primera vez que se usa, o después de una actualización, Claude ejecuta `npm install` dentro de la carpeta de la skill si faltan dependencias. Para exportar a PNG hace falta Playwright con Chromium; sin él, la skill genera igualmente el SVG.

## Uso

Pídeselo a Claude con naturalidad:

- *"Dibújame en estilo pizarra el flujo de alta de un cliente"*
- *"Haz un wireframe a mano de la pantalla de checkout"*
- *"Usa /hand-drawn-diagrams para el proceso de aprobación de facturas"*

También puedes renderizar una especificación directamente:

```bash
cd skills/hand-drawn-diagrams && npm install
node scripts/render.mjs examples/workflow.json --out out/workflow
```

Toda la referencia del formato está en [`reference/spec-format.md`](skills/hand-drawn-diagrams/reference/spec-format.md). Los criterios de color y maquetación están en [`reference/style-guide.md`](skills/hand-drawn-diagrams/reference/style-guide.md).

## Qué puede dibujar

| Tipo | Elementos |
|---|---|
| Procesos y decisiones | cajas, rombos, inicio/fin, notas adhesivas |
| Swimlanes y fases | grupos con borde discontinuo, coloreables |
| Flujos de pantallas | móvil, tablet o escritorio con componentes (inputs, botones, chips, listas, tarjetas, OTP…) y flechas que salen de los botones |
| Wireframes | una sola pantalla con texto realista |

Estilo configurable: fuente (Kalam o Caveat), rugosidad, tipo de relleno, color de acento y semilla.

## Créditos

Creada por [Pau Sánchez](https://github.com/pausanchez) con la ayuda de Claude.
Usa [rough.js](https://roughjs.com), [ELK.js](https://github.com/kieler/elkjs) y [opentype.js](https://opentype.js.org), y las fuentes Kalam y Caveat (SIL OFL 1.1).

## Licencia

[MIT](LICENSE): úsala, modifícala y compártela libremente.
