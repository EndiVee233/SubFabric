/** Distance change distinguishes a pinch from a two-finger translation. */
export function twoFingerMode(startDistance,distance,translation){
  const change=Math.abs(distance-startDistance);
  if(change>=Math.max(12,startDistance*.06)&&change>translation*1.2)return 'pinch';
  if(translation>=10&&change<Math.max(16,translation*.8))return 'range';
  return '';
}
export function pinchView(scale,startDistance,distance,anchorTime,center,limits){
  const next=Math.max(limits.min,Math.min(limits.max,scale*distance/Math.max(1,startDistance)));
  return {scale:next,start:anchorTime-center/next};
}
