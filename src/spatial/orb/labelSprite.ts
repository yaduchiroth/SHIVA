import * as THREE from 'three'

/**
 * A short line of text as a billboarded sprite.
 *
 * Canvas2D rather than geometry text, for the reason the panel faces and the
 * holographic reply both use it: any locally-installed font, no typeface asset,
 * no CDN, and nothing that has to survive the COEP header. A dozen companion
 * labels is a dozen small textures, which is affordable in a way that the
 * fifteen hundred the glyph field would have needed was not.
 *
 * Sprites always face the camera, which is what a label wants and what a plane
 * would need a billboarding shader to achieve.
 */

/** Texture height. Width is measured from the text and rounded up to a power of two. */
const H = 64

export interface Label {
  sprite: THREE.Sprite
  dispose: () => void
}

export function labelSprite(text: string, color: string, worldHeight = 0.16): Label {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')

  const font = `500 ${Math.round(H * 0.5)}px ui-sans-serif, system-ui, -apple-system, sans-serif`
  let width = 256
  if (ctx) {
    ctx.font = font
    // Measure before sizing: a canvas wider than the text wastes texture, and
    // one narrower silently clips it.
    width = Math.min(1024, Math.max(64, Math.ceil(ctx.measureText(text).width + H * 0.6)))
  }
  canvas.width = width
  canvas.height = H

  if (ctx) {
    // Setting width resets the context, so the font has to be applied again.
    ctx.font = font
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = color
    ctx.fillText(text, width / 2, H / 2)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
  })

  const sprite = new THREE.Sprite(material)
  sprite.scale.set((worldHeight * width) / H, worldHeight, 1)

  return {
    sprite,
    dispose: () => {
      texture.dispose()
      material.dispose()
    },
  }
}
