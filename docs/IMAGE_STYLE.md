# Sebastian D. Hunter — Image Generation Style Guide

All images generated for this project (article covers, landmark editorials, future contexts)
must follow these rules. Prompt builders reference this document.

---

## Medium and editorial layer

**Pixel art** is the primary medium. Handcrafted 16-bit / 32-bit era aesthetic. Chunky
pixel clusters, visible pixel grid, crisp hard edges, limited but intentional color palette.
Atmospheric lighting built from pixel color instead of painterly gradients. Isometric or
side-view composition when useful.

**Editorial qualities are layered on top.** The image should have the visual clarity and
deliberateness of a magazine cover — dramatic cinematic framing, strong focal subject,
atmospheric tonal depth, intentional contrast. Think editorial illustration, but rendered
entirely in pixel art.

---

## Accuracy over symbol

Depict the **actual subject matter** as accurately as the pixel medium allows:

- **Time period** — era-correct technology, architecture, clothing silhouettes, vehicles
- **Geography** — correct landscape, climate, terrain, skyline
- **Vehicles** — accurate type (naval vessel, tank, cargo truck, helicopter, etc.)
- **Weapons and equipment** — correct form for the event (rifles, missiles, cranes, barriers)
- **Objects** — infrastructure, containers, machinery, natural features
- **Animals** — accurate species, correct environment

Do not substitute metaphor or abstraction for accuracy. If the article is about a port
blockade, show a port and ships. If it is about a wildfire, show fire and terrain.

---

## Humans

Human figures are **permitted but faces must be blank** — no facial features, no eyes,
no mouths, no hair detail that would identify an individual. Silhouette readability is
fine; individual identity is not.

Figures should convey **action and role through posture and tool/object** in hand,
not through facial expression.

---

## Prohibited elements

- National flags of any country
- Military or police uniforms with visible insignia, rank markings, or national patches
- Religious symbols
- Brand logos or corporate markings
- Text, lettering, numbers, or title cards of any kind inside the image

Functional markings that are part of equipment (e.g. a warning stripe on machinery,
a registration number on a vessel that is not legible at pixel scale) are acceptable
if they do not identify a specific nation or organization.

---

## Stance

Compositions must be **action-oriented**: something is happening, forces are in motion,
objects are being operated, conditions are changing. Avoid static tableau, posed figures,
and symbolic "waiting" compositions.

---

## Aspect ratios

- **Article cover (homepage hero):** 16:9
- **Landmark editorial:** 16:9

---

## Negative prompt (always include)

```
no faces, no facial features, no flags, no national symbols, no insignia, no uniforms
with markings, no text, no letters, no numbers, no logos, no title cards, no UI elements,
no speech bubbles
```

---

## Prompt structure (canonical template)

Implemented in `runner/image_style.js` — import `STYLE_DIRECTIVE` from there rather than
copying the string. The module is the single source of truth; this template is for reference.

```
Pixel art illustration, handcrafted 16-bit/32-bit era aesthetic, chunky pixel clusters,
visible pixel grid, crisp hard edges, limited but intentional color palette.
Editorial composition: dramatic cinematic framing, strong focal subject, atmospheric depth
built from pixel color, deliberate tonal contrast, the visual clarity of a magazine cover
rendered in pixel art.
Human figures as faceless silhouettes — no facial features, posture and tool in hand convey role.
No faces, no flags, no national symbols, no insignia, no uniforms with markings,
no text, no lettering, no numbers, no logos, no title cards, no UI elements.
[SUBJECT: accurate depiction of topic — era, geography, vehicles, objects, animals].
Action-oriented composition — forces in motion, objects being operated. 16:9 cinematic framing.
Polished premium pixel art, cohesive pixel clusters, readable focal subject, no blurry anti-aliasing.
```

Replace `[SUBJECT]` with a precise description of what the image should show,
derived from the article or event data.
