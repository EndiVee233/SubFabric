package com.subfabric.android;

import android.animation.*;
import android.app.Activity;
import android.database.ContentObserver;
import android.graphics.*;
import android.graphics.drawable.Drawable;
import android.os.*;
import android.provider.Settings;
import android.view.*;
import android.view.animation.*;
import android.widget.*;
import java.util.*;
import java.util.function.Consumer;

/** UWP timing, Reveal and touch tilt rendered by Android Views, with no permanent frame loop. */
final class NativeMotion {
    static final int ACCENT=0xff0078d7;
    private static final ArgbEvaluator COLORS=new ArgbEvaluator();
    private final Activity activity;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final Consumer<Boolean> policy;
    private final Set<View> moving=Collections.newSetFromMap(new WeakHashMap<View,Boolean>());
    private final Set<Tile> tiles=Collections.newSetFromMap(new WeakHashMap<Tile,Boolean>());
    private final Set<Animator> animators=Collections.newSetFromMap(new WeakHashMap<Animator,Boolean>());
    private final Map<View,Integer> entries=new WeakHashMap<>();
    private final Map<TextView,ValueAnimator> colors=new WeakHashMap<>();
    private final ContentObserver observer;
    private final android.view.animation.Interpolator ease=new PathInterpolator(.2f,.8f,.2f,1);
    private boolean visible=true,closed;
    private int generation;

    NativeMotion(Activity activity,Consumer<Boolean> policy){
        this.activity=activity;this.policy=policy;
        observer=new ContentObserver(handler){@Override public void onChange(boolean self){refresh();}};
        activity.getContentResolver().registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),false,observer);
    }
    private float dp(float n){return n*activity.getResources().getDisplayMetrics().density;}
    boolean enabled(){return visible&&!closed&&ValueAnimator.areAnimatorsEnabled();}
    void visible(boolean value){visible=value;refresh();}
    private void refresh(){
        if(!enabled())settle();
        policy.accept(enabled());
    }
    private void settle(){
        generation++;
        for(Animator a:new ArrayList<>(animators))a.end();
        animators.clear();
        for(View v:new ArrayList<>(moving))reset(v);
        moving.clear();entries.clear();colors.clear();
        for(Tile tile:new ArrayList<>(tiles))tile.finish();
    }
    void close(){closed=true;settle();handler.removeCallbacksAndMessages(null);activity.getContentResolver().unregisterContentObserver(observer);}
    private void reset(View v){v.animate().cancel();v.setAlpha(1);v.setScaleX(1);v.setScaleY(1);v.setTranslationX(0);v.setTranslationY(0);v.setTranslationZ(0);v.setRotationX(0);v.setRotationY(0);}
    Drawable background(int fill,int border){Tile tile=new Tile(fill,border);tiles.add(tile);return tile;}
    private void start(ValueAnimator a){animators.add(a);a.addListener(new AnimatorListenerAdapter(){@Override public void onAnimationEnd(Animator animation){animators.remove(animation);}});a.start();}
    void press(View v){
        v.setCameraDistance(dp(760));
        v.setOnTouchListener((view,event)->{
            if(view.getBackground()!=null)view.getBackground().setHotspot(event.getX(),event.getY());
            int action=event.getActionMasked();
            if(action==MotionEvent.ACTION_DOWN&&view.isEnabled()&&enabled()){
                float w=Math.max(1,view.getWidth()),h=Math.max(1,view.getHeight());
                float x=Math.max(0,Math.min(1,event.getX()/w)),y=Math.max(0,Math.min(1,event.getY()/h));
                float span=Math.max(w,h),tilt=2.6f*Math.min(span,dp(168))/Math.max(span,dp(168));
                view.animate().cancel();moving.add(view);
                view.setPivotX((1-x)*w);view.setPivotY((1-y)*h);
                view.animate().rotationX((.5f-y)*2*tilt).rotationY((x-.5f)*2*tilt).scaleX(.99f).scaleY(.99f).translationY(dp(1)).translationZ(-dp(1)).setStartDelay(0).setDuration(105).setInterpolator(ease).start();
            }else if(action==MotionEvent.ACTION_UP||action==MotionEvent.ACTION_CANCEL||action==MotionEvent.ACTION_POINTER_DOWN){
                view.animate().cancel();
                if(enabled())view.animate().rotationX(0).rotationY(0).scaleX(1).scaleY(1).translationY(0).translationZ(0).setStartDelay(0).setDuration(action==MotionEvent.ACTION_UP?420:120).setInterpolator(action==MotionEvent.ACTION_UP?new OvershootInterpolator(.55f):ease).withEndAction(()->moving.remove(view)).start();
                else{reset(view);moving.remove(view);}
            }
            return false;
        });
        v.setOnHoverListener((view,event)->{if(view.getBackground()!=null)view.getBackground().setHotspot(event.getX(),event.getY());return false;});
        v.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener(){public void onViewAttachedToWindow(View view){}public void onViewDetachedFromWindow(View view){reset(view);moving.remove(view);}});
    }
    void enter(View v,float scale,float dy,long delay,long duration){
        if(!enabled()||!v.isShown())return;
        reset(v);moving.add(v);v.setPivotX(v.getWidth()*.5f);v.setPivotY(v.getHeight()*.45f);
        v.setAlpha(0);v.setScaleX(scale);v.setScaleY(scale);v.setTranslationY(dp(dy));
        v.animate().alpha(1).scaleX(1).scaleY(1).translationY(0).setStartDelay(delay).setDuration(duration).setInterpolator(ease).withEndAction(()->moving.remove(v)).start();
    }
    void page(ListView list,TextView heading,boolean cues){
        int batch=++generation;entries.put(list,batch);
        list.postOnAnimation(()->{
            if(!Objects.equals(entries.get(list),batch)||!enabled()||!list.isShown())return;
            int count=Math.min(10,list.getChildCount());
            for(int i=0;i<count;i++){
                View child=list.getChildAt(i);if(child.getHeight()==0||child.getTop()>=list.getHeight())continue;
                enter(child,cues?1:.94f,cues?6:0,(cues?i:count-1-i)*24L,cues?120:180);
            }
            if(heading!=null)enter(heading,.97f,0,0,180);
        });
    }
    void color(TextView view,int target){
        int start=view.getCurrentTextColor();if(start==target)return;
        ValueAnimator old=colors.remove(view);if(old!=null)old.cancel();
        if(!enabled()){view.setTextColor(target);return;}
        ValueAnimator a=ValueAnimator.ofArgb(start,target);colors.put(view,a);a.setDuration(120);a.setInterpolator(ease);a.addUpdateListener(v->view.setTextColor((Integer)v.getAnimatedValue()));a.addListener(new AnimatorListenerAdapter(){@Override public void onAnimationEnd(Animator animation){if(colors.get(view)==animation)colors.remove(view);}});start(a);
    }

    /** Only the touched/hovered rectangle is redrawn. No blur, neighbour scan or idle animation. */
    private final class Tile extends Drawable {
        private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        private final int fill,border;
        private float x=-1,y=-1,light,selection,focus,toLight,toSelection,toFocus;
        private boolean enabled=true;
        private int alpha=255;
        private ValueAnimator animator;
        private Shader sheen,face,edge;
        Tile(int fill,int border){this.fill=fill;this.border=border;}
        @Override public boolean isStateful(){return true;}
        @Override public void setHotspot(float x,float y){if(this.x==x&&this.y==y)return;this.x=x;this.y=y;spotlight();invalidateSelf();}
        @Override protected void onBoundsChange(Rect bounds){sheen=new LinearGradient(0,bounds.top,0,Math.max(bounds.top+1,bounds.bottom),0x08ffffff,0x00ffffff,Shader.TileMode.CLAMP);spotlight();}
        private void spotlight(){Rect r=getBounds();float cx=x<0?r.exactCenterX():x,cy=y<0?r.exactCenterY():y,radius=Math.max(dp(40),Math.min(r.width(),r.height())*1.2f);face=new RadialGradient(cx,cy,radius,0x1fffffff,0x00ffffff,Shader.TileMode.CLAMP);edge=new RadialGradient(cx,cy,radius,0x80ffffff,0x00ffffff,Shader.TileMode.CLAMP);}
        @Override protected boolean onStateChange(int[] state){
            boolean pressed=false,hover=false,focused=false,active=false;enabled=false;
            for(int s:state){if(s==android.R.attr.state_enabled)enabled=true;if(s==android.R.attr.state_pressed)pressed=true;if(s==android.R.attr.state_hovered)hover=true;if(s==android.R.attr.state_focused)focused=true;if(s==android.R.attr.state_activated)active=true;}
            float l=enabled?(pressed?1:hover?.65f:focused?.35f:0):0,sel=active?1:0,f=focused?1:0;
            if(l==toLight&&sel==toSelection&&f==toFocus)return true;
            toLight=l;toSelection=sel;toFocus=f;
            if(animator!=null)animator.cancel();
            if(!NativeMotion.this.enabled()||!(getCallback() instanceof View)||!((View)getCallback()).isAttachedToWindow()){finish();return true;}
            float startLight=light,startSelection=selection,startFocus=focus;
            animator=ValueAnimator.ofFloat(0,1);animator.setDuration(120);animator.setInterpolator(ease);
            animator.addUpdateListener(a->{float t=(Float)a.getAnimatedValue();light=startLight+(toLight-startLight)*t;selection=startSelection+(toSelection-startSelection)*t;focus=startFocus+(toFocus-startFocus)*t;invalidateSelf();});start(animator);return true;
        }
        void finish(){if(animator!=null)animator.cancel();light=toLight;selection=toSelection;focus=toFocus;invalidateSelf();}
        private int blend(int a,int b,float t){return (Integer)COLORS.evaluate(t,a,b);}
        @Override public void draw(Canvas canvas){
            Rect r=getBounds();float stroke=dp(1),inset=stroke*.5f;
            RectF box=new RectF(r.left+inset,r.top+inset,r.right-inset,r.bottom-inset);
            paint.setStyle(Paint.Style.FILL);paint.setShader(null);
            paint.setColor(blend(fill,0xff173c54,selection));paint.setAlpha(alpha);canvas.drawRect(box,paint);
            paint.setColor(Color.WHITE);paint.setShader(sheen);canvas.drawRect(box,paint);paint.setShader(null);
            paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(stroke+focus*stroke);
            paint.setColor(blend(border,ACCENT,Math.max(focus,selection*.8f)));canvas.drawRect(box,paint);
            if(light>0&&enabled){
                paint.setColor(Color.WHITE);paint.setAlpha(Math.round(light*alpha));paint.setStyle(Paint.Style.FILL);paint.setShader(face);canvas.drawRect(box,paint);
                paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(stroke);paint.setShader(edge);canvas.drawRect(box,paint);paint.setShader(null);
            }
            if(selection>0){paint.setStyle(Paint.Style.FILL);paint.setColor(Color.argb(Math.round(255*selection),0,120,215));canvas.drawRect(r.left,r.top,r.left+dp(2),r.bottom,paint);}
        }
        @Override public void setAlpha(int alpha){this.alpha=alpha;invalidateSelf();}
        @Override public void setColorFilter(ColorFilter filter){paint.setColorFilter(filter);invalidateSelf();}
        @Override public int getOpacity(){return PixelFormat.TRANSLUCENT;}
    }

    /** A moving accent strip survives snapshot updates and changes axis for the tablet rail. */
    final class Pivot extends LinearLayout {
        private final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        private int selected=-1;
        private float from,to;
        private ValueAnimator animator;
        Pivot(){super(activity);setWillNotDraw(false);}
        void select(int index){if(selected==index)return;selected=index;post(()->position(true));}
        private void position(boolean animate){
            if(selected<0||selected>=getChildCount())return;View child=getChildAt(selected);boolean vertical=getOrientation()==VERTICAL;
            float a=vertical?child.getTop():child.getLeft(),b=vertical?child.getBottom():child.getRight();
            if(a==from&&b==to)return;if(animator!=null)animator.cancel();
            if(!animate||!enabled()||to==0){from=a;to=b;invalidate();return;}
            float oldFrom=from,oldTo=to;animator=ValueAnimator.ofFloat(0,1);animator.setDuration(180);animator.setInterpolator(ease);
            animator.addUpdateListener(v->{float t=(Float)v.getAnimatedValue();from=oldFrom+(a-oldFrom)*t;to=oldTo+(b-oldTo)*t;invalidate();});start(animator);
        }
        @Override protected void onLayout(boolean changed,int l,int t,int r,int b){super.onLayout(changed,l,t,r,b);if(changed)position(false);}
        @Override protected void dispatchDraw(Canvas canvas){super.dispatchDraw(canvas);if(selected<0)return;paint.setColor(ACCENT);if(getOrientation()==VERTICAL)canvas.drawRect(0,from+dp(8),dp(3),to-dp(8),paint);else canvas.drawRect(from+dp(8),getHeight()-dp(3),to-dp(8),getHeight(),paint);}
        @Override protected void onDetachedFromWindow(){if(animator!=null)animator.cancel();super.onDetachedFromWindow();}
    }
}
