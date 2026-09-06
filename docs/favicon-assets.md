# Favicon assets

Prepared with the built-in imagegen tool from the user-provided icon. The SVG tile clipping removes remaining edge artifacts before PNG exports at 192 and 512 px. The favicon embeds the 192 px PNG and works without external resource requests, including on the corporate login page.

## Final editing prompt

Use case: background-extraction / precise-object-edit. Edit target: the supplied QA rounded-square app icon. Prepare this exact icon as a finished production favicon. Preserve the QA letterforms and check mark, composition, internal translucent glossy gradients, and original red palette. Remove ONLY the outer perimeter stroke, beveled outline rim, neon fringe, stray pixels and external glow/shadow around the rounded-square tile. Clean smooth antialiased rounded corners. Genuine transparent background outside the tile, no border, no white or black matte. Crop the square canvas tightly to the tile extents so icon fills nearly entire canvas. One icon only, no labels, no mockup. Do not redesign the mark.

The manifest icon URLs carry `?v=2`: browsers must see a new icon URL when the artwork changes. Keep the manifest URL and app ID stable. The service worker precaches both versioned icon URLs. Updating the editor does not directly replace the operating system app icon; the browser handles installed app identity updates separately.
