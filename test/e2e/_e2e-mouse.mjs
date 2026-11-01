// ════════════════════════════════════════════════════════════════════════════
// Echte Eingaben für Abnahmeläufe: Maus und Tastatur über CDP, nicht `element.click()`.
// `element.click()` trifft auch, was verdeckt, abgeschnitten oder 0 × 0 groß ist — genau das soll eine
// Abnahme aber finden. Deshalb prüft jeder Klick zuerst: Gibt es das Element, hat es eine Größe, und liegt es
// an dieser Stelle wirklich zuoberst? Nur dann geht der Mausklick hinaus.
// ════════════════════════════════════════════════════════════════════════════

const S = (v) => JSON.stringify(v);

async function klickePunkt(c, x, y) {
  await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

/** Ein Mausklick auf das Element. Antwort: 'OK' oder warum nicht (`FEHLT`, `UNSICHTBAR`, `VERDECKT`, `GESPERRT`). */
export async function maus(c, sel) {
  const p = await c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return {fehlt:1};
    e.scrollIntoView({block:'center',inline:'center'});
    const r=e.getBoundingClientRect(); const x=r.left+r.width/2, y=r.top+r.height/2;
    const t=document.elementFromPoint(x,y);
    const l=e.closest('label');
    return {x,y,w:r.width,h:r.height,gesperrt:!!e.disabled,oben:!!t&&(t===e||e.contains(t)||t.contains(e)||(l&&l.contains(t)))};`);
  if (p.fehlt) return 'FEHLT:' + sel;
  if (!p.w || !p.h) return 'UNSICHTBAR:' + sel;
  if (p.gesperrt) return 'GESPERRT:' + sel;
  if (!p.oben) return 'VERDECKT:' + sel;
  await klickePunkt(c, p.x, p.y);
  return 'OK';
}

/** Ein Mausklick auf den Knopf mit genau diesem Text (der letzte, wenn es mehrere gibt: der obenliegende Dialog). */
export async function mausText(c, text) {
  const da = await c.ev(`const b=[...document.querySelectorAll('button,a')].filter(x=>x.textContent.trim()===${S(text)}&&x.getClientRects().length).pop();
    document.querySelectorAll('[data-e2e-ziel]').forEach(x=>x.removeAttribute('data-e2e-ziel'));
    if(!b) return false; b.setAttribute('data-e2e-ziel','1'); return true;`);
  if (!da) return 'FEHLT:' + text;
  return maus(c, '[data-e2e-ziel]');
}

/** In das Feld klicken, alles markieren und tippen. Ein leerer Wert löscht den Inhalt mit der Entf-Taste. */
export async function tippe(c, sel, wert) {
  const r = await maus(c, sel);
  if (r !== 'OK') return r;
  await c.ev(`const e=document.querySelector(${S(sel)}); e.focus(); if(e.select) e.select(); return 1;`);
  if (String(wert) === '') {
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  } else {
    await c.send('Input.insertText', { text: String(wert) });
  }
  return 'OK';
}

/** Eine Auswahlliste: sichtbar prüfen, dann den Wert wählen (die Liste selbst öffnet CDP nicht). */
export async function waehle(c, sel, wert) {
  return c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return 'FEHLT:'+${S(sel)};
    e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); if(!r.width||!r.height) return 'UNSICHTBAR:'+${S(sel)};
    if(![...e.options].some(o=>o.value===${S(wert)})) return 'KEINE-OPTION:'+${S(wert)};
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e, ${S(wert)});
    e.dispatchEvent(new Event('change',{bubbles:true})); return 'OK';`);
}

/** Ist das Element wirklich sichtbar (nicht nur im Dokument)? */
export const sichtbar = (c, sel) => c.ev(`const e=document.querySelector(${S(sel)}); if(!e) return false; const r=e.getBoundingClientRect(); const s=getComputedStyle(e); return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none';`);
