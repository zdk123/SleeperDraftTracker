(function (App) {
  'use strict';

  // Turns the viewer link into something people can point a phone at.
  //
  // SVG rather than canvas: the same node is shown small on the board and then
  // blown up full-screen for the "everyone scan now" moment, and vectors scale
  // to any size without regenerating or going soft. It also survives the board
  // re-rendering after every pick, since the node can simply be moved.

  const QUIET_ZONE = 4; // modules of clear margin; the spec requires 4

  /**
   * Error correction is deliberately the LOWEST level (L, ~7%).
   *
   * That is backwards from the usual advice, and right here: this code is
   * displayed on a clean screen, so physical damage -- the thing higher levels
   * protect against -- cannot happen. What actually stops a scan is too few
   * pixels per module at distance, and L needs the fewest modules. For our link
   * it is 53x53 where M would be 61x61, making every module 15% larger for the
   * same area on the TV.
   */
  const ECC = 'L';

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /**
   * @param {string} text
   * @returns {SVGElement} a square SVG with a viewBox in module units, so the
   *   caller sizes it purely with CSS.
   */
  function render(text) {
    const qr = window.qrcode(0, ECC); // 0 = smallest version that fits
    qr.addData(text);
    qr.make();

    const count = qr.getModuleCount();
    const size = count + QUIET_ZONE * 2;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR code linking to the read-only draft view');

    // The quiet zone must be light even in dark mode -- a QR inverted or run
    // right to the edge is a QR that will not scan.
    const bg = document.createElementNS(SVG_NS, 'rect');
    bg.setAttribute('width', String(size));
    bg.setAttribute('height', String(size));
    bg.setAttribute('fill', '#ffffff');
    svg.append(bg);

    // One <path> of many subpaths rather than thousands of <rect> nodes: a
    // 53x53 code is ~1,400 dark modules, and that many elements is enough to
    // make the board's re-render visibly stutter on a modest laptop.
    let d = '';
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) d += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`;
      }
    }
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', '#000000');
    svg.append(path);

    return svg;
  }

  App.views = App.views || {};
  App.views.qrcode = {
    ECC,
    render,

    /** Module count for a payload, without building any DOM. For tests. */
    moduleCount(text) {
      const qr = window.qrcode(0, ECC);
      qr.addData(text);
      qr.make();
      return qr.getModuleCount();
    },
  };
})(window.DraftApp);
