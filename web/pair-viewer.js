import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {createIblRig} from './ibl.js';
export async function pairViewer(canvases,urls,mode='clay'){
 const panes=[],loader=new GLTFLoader();let stopped=false,syncing=false;
 try{for(let i=0;i<2;i++){
  const renderer=new THREE.WebGLRenderer({canvas:canvases[i],antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
  const scene=new THREE.Scene();scene.background=new THREE.Color('#20252e');const camera=new THREE.OrthographicCamera(-.65,.65,.65,-.65,.001,20),controls=new OrbitControls(camera,canvases[i]),ibl=createIblRig(renderer,scene),parts=[];
  panes.push({renderer,scene,camera,controls,ibl,parts});
  scene.add(new THREE.HemisphereLight(0xffffff,0x444455,.15));const l=new THREE.DirectionalLight(0xffffff,.6);l.position.set(3,3,2);scene.add(l);
  const gltf=await loader.loadAsync(urls[i]),box=new THREE.Box3().setFromObject(gltf.scene),size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3()),wrap=new THREE.Group();wrap.add(gltf.scene);gltf.scene.position.sub(center);wrap.scale.setScalar(1/Math.max(size.y,1e-6));scene.add(wrap);
  gltf.scene.traverse(o=>{if(o.isMesh){const originals=Array.isArray(o.material)?o.material:[o.material],unlit=originals.map(m=>new THREE.MeshBasicMaterial({map:m.map,color:m.color,side:m.side})),clay=new THREE.MeshStandardMaterial({color:0xdedede,roughness:.75});parts.push({mesh:o,original:o.material,unlit:Array.isArray(o.material)?unlit:unlit[0],clay});}});
  await ibl.ready;
 }}catch(e){for(const p of panes){p.controls.dispose();p.ibl.dispose();p.renderer.dispose();}throw e;}
 const dirs={front:[2,0,0],left:[0,0,-2],right:[0,0,2],back:[-2,0,0]};
 function view(v){for(const p of panes){p.camera.position.fromArray(dirs[v]);p.controls.target.set(0,0,0);p.camera.zoom=1;p.camera.updateProjectionMatrix();p.controls.update();}}
 function setMode(m){for(const p of panes){for(const x of p.parts)x.mesh.material=m==='clay'?x.clay:m==='unlit'?x.unlit:x.original;p.ibl.set({enabled:m!=='unlit',intensity:1,preset:'studio'});}}
 for(const p of panes)p.controls.addEventListener('change',()=>{if(syncing)return;syncing=true;for(const other of panes)if(other!==p){other.camera.position.copy(p.camera.position);other.camera.quaternion.copy(p.camera.quaternion);other.camera.zoom=p.camera.zoom;other.camera.updateProjectionMatrix();other.controls.target.copy(p.controls.target);other.controls.update();}syncing=false;});
 setMode(mode);view('front');
 const resize=()=>{for(const p of panes){const w=p.renderer.domElement.clientWidth;p.renderer.setSize(w,w,false);}};const observer=new ResizeObserver(resize);canvases.forEach(c=>observer.observe(c));resize();
 function frame(){if(stopped)return;for(const p of panes)p.renderer.render(p.scene,p.camera);requestAnimationFrame(frame);}frame();
 return {view,setMode,dispose(){stopped=true;observer.disconnect();for(const p of panes){p.controls.dispose();p.scene.traverse(o=>{o.geometry?.dispose();});for(const x of p.parts){for(const m of [x.clay,...(Array.isArray(x.unlit)?x.unlit:[x.unlit]),...(Array.isArray(x.original)?x.original:[x.original])]){for(const value of Object.values(m))if(value?.isTexture)value.dispose();m.dispose();}}p.ibl.dispose();p.renderer.dispose();}}};
}
