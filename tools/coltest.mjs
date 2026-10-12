import { Terrain } from '../js/terrain.js';
import { Scenery } from '../js/scenery.js';
const t0 = Date.now();
const T = new Terrain();
const S = new Scenery(T);
console.log('build ms', Date.now() - t0, 'boxes', S.boxes.length);
// fly east (perpendicular to the bridge) at various heights through the mid-span
const hdg = 84 * Math.PI / 180;
for (const y of [20, 45, 57, 62, 70, 90, 150, 240]) {
  let hit = null;
  for (let s = -600; s <= 600 && !hit; s += 2) {
    const p = [Math.sin(hdg) * s, y, -Math.cos(hdg) * s];
    hit = S.collide(p);
  }
  console.log(`mid-span pass at ${y} m:`, hit || 'clear');
}
// through a tower
const tw = [Math.sin(354 * Math.PI / 180) * 640, 100, -Math.cos(354 * Math.PI / 180) * 640];
console.log('tower point:', S.collide(tw));
console.log('terrain at SFO', T.heightAt(...[9600, 22300]).toFixed(1), 'Mt Tam', T.heightAt(-10400, -11500).toFixed(0), 'Twin Peaks', T.heightAt(2700, 7300).toFixed(0), 'Diablo', T.heightAt(...(()=>{return [50300, -6700]})()).toFixed(0));
