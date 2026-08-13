/**
 * Set up a minimal DOM + canvas environment so litegraph can construct nodes
 * and serialize graphs under node --test (no real rendering).
 *
 * Usage at the top of a test file:
 *   import { setupLitegraphEnvDom } from './_litegraphEnv.mjs'
 *   await setupLitegraphEnvDom()  // wires window/document globals
 *   // then load litegraph + app modules via vite.ssrLoadModule for one instance
 */
import { Window } from 'happy-dom'

export async function setupLitegraphEnvDom() {
  const window = new Window({ url: 'http://localhost/' })
  const document = window.document

  // Canvas.getContext stub: litegraph touches ctx at render time and reads a
  // few properties in LGraphCanvas construction.
  class FakeCtx {
    constructor() {
      this.canvas = { width: 800, height: 600 }
    }
    measureText() { return { width: 10 } }
    getImageData() { return { data: new Uint8ClampedArray(4) } }
    save() {} restore() {} translate() {} rotate() {} scale() {}
    fillRect() {} strokeRect() {} clearRect() {} fillText() {} strokeText() {}
    beginPath() {} moveTo() {} lineTo() {} arc() {} closePath() {} fill() {} stroke() {}
    setTransform() {} drawImage() {}
    createLinearGradient() { return {} }
    createRadialGradient() { return {} }
  }
  window.HTMLCanvasElement.prototype.getContext = function () {
    if (!this.__ctx) this.__ctx = new FakeCtx()
    return this.__ctx
  }
  window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { x: 0, y: 0, width: this.width || 800, height: this.height || 600, top: 0, left: 0 }
  }

  // Expose the globals litegraph reads (window, document, navigator, ...).
  const define = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true })
  define('window', window)
  define('document', document)
  define('navigator', window.navigator)
  define('HTMLElement', window.HTMLElement)
  define('HTMLCanvasElement', window.HTMLCanvasElement)
  define('localStorage', window.localStorage)
  if (!globalThis.requestAnimationFrame) {
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
    globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
  }
}
