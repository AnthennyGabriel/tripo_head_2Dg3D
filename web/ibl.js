import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

/** Shared, local IBL rig for the standalone viewer and comparison workbench. */
export function createIblRig(renderer, scene, { url = '/assets/environments/studio_small_09_1k.hdr' } = {}) {
  const pmrem=new THREE.PMREMGenerator(renderer),room=new RoomEnvironment();
  const roomTarget=pmrem.fromScene(room,.04);room.dispose();
  let studioTarget,enabled=true,intensity=1,preset='studio',disposed=false;
  const apply=()=>{
    scene.environment=enabled?(preset==='studio'&&studioTarget?studioTarget.texture:roomTarget.texture):null;
    scene.traverse(o=>{if(o.isMesh)for(const m of Array.isArray(o.material)?o.material:[o.material])if(m&&'envMapIntensity'in m)m.envMapIntensity=intensity;});
  };
  const rig={error:null,source:'room',set(options={}){({enabled=enabled,intensity=intensity,preset=preset}=options);apply();},dispose(){disposed=true;studioTarget?.dispose();roomTarget.dispose();pmrem.dispose();}};
  rig.ready=new RGBELoader().loadAsync(url).then(texture=>{
    if(disposed){texture.dispose();return;}
    studioTarget=pmrem.fromEquirectangular(texture);texture.dispose();rig.source='hdr';apply();
  }).catch(e=>{rig.error=e.message;rig.source='room';apply();});
  apply();return rig;
}
