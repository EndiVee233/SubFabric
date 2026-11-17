package com.subfabric.android;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.*;
import android.os.*;
import android.text.*;
import android.view.*;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import android.widget.*;
import java.util.*;
import org.json.*;

/** Android View front end. The WebView owns only the shared controller and rendering surfaces. */
final class NativeStudio {
    private static final int BG=0xff151515,SURFACE=0xff242424,FG=0xfff4f4f4,MUTED=0xffa9a9a9,ACCENT=0xff0078d7;
    private final Activity activity;
    private final WebView web;
    private final NativeMotion motion;
    private final Handler handler=new Handler(Looper.getMainLooper());
    private final LinearLayout root,header,panel,editorBody;
    private final NativeMotion.Pivot nav,tabs;
    private final FrameLayout middle;
    private final TextView title,save;
    private final Button back,export;
    private final FrameLayout surface;
    private final Button play,mute,rate;
    private final TextView clock;
    private final SeekBar seek;
    private boolean seeking;
    private final ListView pageList,cueList,controlList;
    private final Rows pageRows=new Rows(),controlRows=new Rows();
    private final Cues cues=new Cues();
    private JSONObject state=new JSONObject();
    private String route="",tab="",section="",project="",modalId="",editId="",playing="",selected="";
    private AlertDialog modal,editDialog,filterDialog;
    private boolean editor,applying,closed;
    private int lastWidth,lastHeight;
    private long manualUntil;
    private String lastFollow="";
    private JSONObject pending;
    private EditText activeInput;
    private Rows modalRows,lastDialogRows;
    private String modalContents="";
    private final View cueTail;

    NativeStudio(Activity activity,WebView web){
        this.activity=activity;this.web=web;
        motion=new NativeMotion(activity,enabled->web.evaluateJavascript("window.__androidSetMotion?.("+enabled+")",null));
        root=column();root.setBackgroundColor(BG);root.setFocusableInTouchMode(true);
        header=row();header.setPadding(dp(8),0,dp(8),0);header.setBackgroundColor(SURFACE);
        back=button("‹",()->send("back"));back.setContentDescription("返回稿件库");header.addView(back,new LinearLayout.LayoutParams(dp(64),dp(48)));
        title=text("SubFabric",20,FG);title.setSingleLine(true);title.setEllipsize(TextUtils.TruncateAt.END);header.addView(title,new LinearLayout.LayoutParams(0,dp(48),1));
        save=text("",11,MUTED);save.setSingleLine(true);save.setMaxWidth(dp(90));save.setEllipsize(TextUtils.TruncateAt.END);header.addView(save);
        export=button("导出",()->send("export"));export.setBackground(background(ACCENT,ACCENT));header.addView(export,new LinearLayout.LayoutParams(dp(70),dp(48)));
        root.addView(header,new LinearLayout.LayoutParams(-1,dp(48)));
        middle=new FrameLayout(activity){@Override protected void onSizeChanged(int w,int h,int oldw,int oldh){super.onSizeChanged(w,h,oldw,oldh);if(w!=oldw||h!=oldh)handler.post(()->layoutSurface());}};
        root.addView(middle,new LinearLayout.LayoutParams(-1,0,1));
        pageList=list();pageList.setAdapter(pageRows);
        surface=new FrameLayout(activity);surface.addView(web,new FrameLayout.LayoutParams(-1,-1));
        LinearLayout player=row();player.setBackgroundColor(SURFACE);
        play=button("▷",()->send("play"));play.setContentDescription("播放或暂停");player.addView(play,new LinearLayout.LayoutParams(dp(44),dp(40)));
        clock=text("00:00",10,MUTED);player.addView(clock,new LinearLayout.LayoutParams(dp(42),dp(40)));
        seek=new SeekBar(activity);seek.setMax(100000);player.addView(seek,new LinearLayout.LayoutParams(0,dp(40),1));seek.setContentDescription("播放进度");
        seek.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onStartTrackingTouch(SeekBar b){seeking=true;}public void onStopTrackingTouch(SeekBar b){seeking=false;command(obj("kind","seek","time",state.optDouble("duration")*b.getProgress()/100000));lastFollow="";manualUntil=0;}public void onProgressChanged(SeekBar b,int value,boolean user){}});
        mute=button("♪",()->send("mute"));mute.setContentDescription("切换静音");player.addView(mute,new LinearLayout.LayoutParams(dp(44),dp(40)));
        rate=button("1×",()->{String[] values={"0.5×","0.75×","1×","1.25×","1.5×","2×"};double[] speeds={.5,.75,1,1.25,1.5,2};new AlertDialog.Builder(activity).setTitle("播放速度").setItems(values,(d,i)->command(obj("kind","rate","value",speeds[i]))).show();});player.addView(rate,new LinearLayout.LayoutParams(dp(50),dp(40)));
        FrameLayout.LayoutParams playerLayout=new FrameLayout.LayoutParams(-1,dp(40),Gravity.BOTTOM);playerLayout.bottomMargin=dp(140);surface.addView(player,playerLayout);
        editorBody=column();panel=column();panel.setBackgroundColor(BG);
        tabs=motion.new Pivot();tabs.setGravity(Gravity.CENTER_VERTICAL);panel.addView(tabs,new LinearLayout.LayoutParams(-1,dp(48)));
        cueList=list();cueTail=new View(activity);cueTail.setLayoutParams(new AbsListView.LayoutParams(-1,dp(300)));cueList.addFooterView(cueTail,null,false);cueList.setAdapter(cues);cueList.setDividerHeight(dp(6));
        cueList.setOnTouchListener((v,event)->{if(event.getActionMasked()==MotionEvent.ACTION_DOWN)manualUntil=System.currentTimeMillis()+5000;return false;});
        cueList.setOnScrollListener(new AbsListView.OnScrollListener(){public void onScrollStateChanged(AbsListView v,int mode){if(mode!=SCROLL_STATE_IDLE)manualUntil=System.currentTimeMillis()+5000;}public void onScroll(AbsListView v,int a,int b,int c){}});
        controlList=list();controlList.setAdapter(controlRows);
        nav=motion.new Pivot();nav.setGravity(Gravity.CENTER_VERTICAL);nav.setBackgroundColor(SURFACE);
        for(String label:new String[]{"主页","稿件","设置"}){
            Button b=button(label,()->command(obj("kind","route","route",label.equals("主页")?"#/dashboard":label.equals("稿件")?"#/home":"#/settings")));
            nav.addView(b,new LinearLayout.LayoutParams(0,dp(56),1));
        }
        root.addView(nav,new LinearLayout.LayoutParams(-1,dp(56)));
        middle.addView(surface,new FrameLayout.LayoutParams(-1,-1));middle.addView(pageList,new FrameLayout.LayoutParams(-1,-1));
        activity.setContentView(root);
        title.setText("正在载入…");
    }
    private int dp(float value){return Math.round(value*activity.getResources().getDisplayMetrics().density);}
    private LinearLayout column(){LinearLayout v=new LinearLayout(activity);v.setOrientation(LinearLayout.VERTICAL);return v;}
    private LinearLayout row(){LinearLayout v=new LinearLayout(activity);v.setOrientation(LinearLayout.HORIZONTAL);v.setGravity(Gravity.CENTER_VERTICAL);return v;}
    private TextView text(String value,int size,int color){TextView v=new TextView(activity);v.setText(value);v.setTextSize(size);v.setTextColor(color);v.setGravity(Gravity.CENTER_VERTICAL);v.setFontFeatureSettings("kern");return v;}
    private Drawable background(int fill,int border){return motion.background(fill,border);}
    private void press(View v){motion.press(v);}
    private Button button(String label,Runnable click){Button b=new Button(activity);b.setAllCaps(false);b.setText(label);b.setTextSize(14);b.setTextColor(FG);b.setMinHeight(dp(48));b.setMinimumHeight(dp(48));b.setMinWidth(0);b.setMinimumWidth(0);b.setPadding(dp(12),0,dp(12),0);b.setBackground(background(SURFACE,0xff666666));b.setOnClickListener(v->{blur();click.run();});press(b);return b;}
    private ListView list(){ListView l=new ListView(activity);l.setBackgroundColor(BG);l.setDivider(null);l.setClipToPadding(false);l.setPadding(dp(10),dp(8),dp(10),dp(24));l.setItemsCanFocus(true);l.setFocusableInTouchMode(true);l.setDescendantFocusability(ViewGroup.FOCUS_BEFORE_DESCENDANTS);return l;}
    private static JSONObject obj(Object... values){JSONObject o=new JSONObject();try{for(int i=0;i<values.length;i+=2)o.put((String)values[i],values[i+1]);}catch(JSONException e){throw new IllegalArgumentException(e);}return o;}
    private void send(String kind){command(obj("kind",kind));}
    private void command(JSONObject action){if(closed)return;try{action.put("routeOwner",route);if(editor&&!action.has("project"))action.put("project",project);}catch(JSONException ignored){}web.evaluateJavascript("window.androidNative?.command("+action.toString()+")",null);}
    private void blur(){Dialog owner=editDialog!=null?editDialog:modal!=null?modal:filterDialog!=null&&filterDialog.isShowing()?filterDialog:null;View focus=owner!=null?owner.getCurrentFocus():activity.getCurrentFocus();InputMethodManager input=(InputMethodManager)activity.getSystemService(Context.INPUT_METHOD_SERVICE);if(focus!=null){if(input!=null)input.hideSoftInputFromWindow(focus.getWindowToken(),0);focus.clearFocus();}View target=owner!=null?owner.getWindow().getDecorView():root;target.setFocusableInTouchMode(true);target.requestFocus();pending=null;}

    void accept(JSONObject next){
        if(closed)return;
        if(next.has("error")){Toast.makeText(activity,next.optString("error"),Toast.LENGTH_LONG).show();return;}
        if(next.optBoolean("tick")){tick(next);return;}
        View focus=modal!=null?modal.getCurrentFocus():activity.getCurrentFocus();
        if(focus instanceof EditText&&focus==activeInput&&!next.has("edit")&&next.optString("route").equals(route)&&next.optString("tab").equals(tab)){pending=next;return;}
        state=next;boolean changed=editor!=next.optBoolean("editor")||!route.equals(next.optString("route"));boolean tabChanged=!tab.equals(next.optString("tab")),sectionChanged=!section.equals(next.optString("section"));section=next.optString("section");
        editor=next.optBoolean("editor");route=next.optString("route");project=next.optString("project");tab=next.optString("tab");
        back.setText(editor?"‹ 稿件":"‹");title.setText(editor?"":next.optString("title","SubFabric"));save.setText(editor?next.optString("save"):"");export.setVisibility(editor?View.VISIBLE:View.GONE);nav.setVisibility(editor?View.GONE:View.VISIBLE);
        if(changed){manualUntil=0;lastFollow="";lastWidth=0;layoutSurface();}
        applying=true;
        if(editor){buildTabs();if(tab.equals("subs")){cues.set(next.optJSONArray("rows"));showContent(cueList);}else{controlRows.set(next.optJSONArray("controls"));showContent(controlList);}}
        else pageRows.set(next.optJSONArray("controls"));
        if(changed||sectionChanged){root.requestFocus();pageList.post(()->pageList.setSelection(0));}
        if(tabChanged)controlList.post(()->controlList.setSelection(0));
        applying=false;
        syncModal(next.optJSONObject("modal"));syncEdit(next.optJSONObject("edit"));
        for(int i=0;i<nav.getChildCount();i++){Button b=(Button)nav.getChildAt(i);boolean active=i==0&&route.equals("#/dashboard")||i==1&&(route.equals("#/home")||route.equals("#/new")||route.startsWith("#/details/"))||i==2&&(route.startsWith("#/settings")||route.equals("#/storage"));b.setActivated(active);motion.color(b,active?0xff48b8ff:FG);if(active)nav.select(i);}
        if(changed||sectionChanged||editor&&tabChanged){ListView list=editor?(tab.equals("subs")?cueList:controlList):pageList;motion.page(list,changed?title:null,editor&&tab.equals("subs"));}
    }
    private void showContent(View child){if(child.getParent()==panel)return;for(int i=panel.getChildCount()-1;i>=1;i--)panel.removeViewAt(i);detach(child);panel.addView(child,new LinearLayout.LayoutParams(-1,0,1));}
    private void buildTabs(){
        String[][] choices={{"subs","字幕"},{"roles","角色"},{"settings","工具"}};
        if(tabs.getChildCount()==0){
            for(String[] choice:choices){Button b=button(choice[1],()->command(obj("kind","tab","tab",choice[0])));b.setBackground(background(BG,Color.TRANSPARENT));tabs.addView(b,new LinearLayout.LayoutParams(0,dp(48),1));}
            Button filter=button("⌕",()->{if(filterDialog!=null)filterDialog.dismiss();filterDialog=dialog("筛选字幕",state.optJSONArray("controls"),null);});filter.setContentDescription("筛选字幕");tabs.addView(filter,new LinearLayout.LayoutParams(dp(44),dp(48)));
        }
        for(int i=0;i<choices.length;i++){Button b=(Button)tabs.getChildAt(i);boolean active=tab.equals(choices[i][0]);b.setActivated(active);motion.color(b,active?0xff48b8ff:MUTED);if(active)tabs.select(i);}
        tabs.getChildAt(3).setVisibility(tab.equals("subs")?View.VISIBLE:View.GONE);
    }
    private void layoutSurface(){
        int w=middle.getWidth(),h=middle.getHeight();if(w<=0||h<=0||w==lastWidth&&h==lastHeight)return;lastWidth=w;lastHeight=h;
        detach(surface);detach(pageList);detach(editorBody);detach(panel);editorBody.removeAllViews();surface.setImportantForAccessibility(editor?View.IMPORTANT_FOR_ACCESSIBILITY_AUTO:View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
        boolean tablet=w/activity.getResources().getDisplayMetrics().density>=760;
        if(!editor){
            detach(nav);nav.setOrientation(tablet?LinearLayout.VERTICAL:LinearLayout.HORIZONTAL);
            for(int i=0;i<nav.getChildCount();i++)nav.getChildAt(i).setLayoutParams(tablet?new LinearLayout.LayoutParams(-1,dp(56)):new LinearLayout.LayoutParams(0,dp(56),1));
            middle.addView(surface,new FrameLayout.LayoutParams(-1,-1));FrameLayout.LayoutParams pageLayout=new FrameLayout.LayoutParams(-1,-1);if(tablet)pageLayout.leftMargin=dp(112);middle.addView(pageList,pageLayout);
            if(tablet)middle.addView(nav,new FrameLayout.LayoutParams(dp(112),-1,Gravity.LEFT));else root.addView(nav,new LinearLayout.LayoutParams(-1,dp(56)));
            return;
        }
        float width=w/activity.getResources().getDisplayMetrics().density,height=h/activity.getResources().getDisplayMetrics().density;
        boolean side=width>=760||width>height*1.25;
        editorBody.setOrientation(side?LinearLayout.HORIZONTAL:LinearLayout.VERTICAL);
        if(side){editorBody.addView(surface,new LinearLayout.LayoutParams(0,-1,1));editorBody.addView(panel,new LinearLayout.LayoutParams(0,-1,1));}
        else{int mediaHeight=Math.min(dp(width*9/16+180),Math.max(dp(180),h-dp(200)));editorBody.addView(surface,new LinearLayout.LayoutParams(-1,mediaHeight));editorBody.addView(panel,new LinearLayout.LayoutParams(-1,0,1));}
        middle.addView(editorBody,new FrameLayout.LayoutParams(-1,-1));
        panel.post(()->{cueTail.setLayoutParams(new AbsListView.LayoutParams(-1,Math.max(dp(80),cueList.getHeight()-dp(48))));lastFollow="";});
    }
    private static void detach(View v){if(v.getParent() instanceof ViewGroup)((ViewGroup)v.getParent()).removeView(v);}
    private void tick(JSONObject tick){
        String active=tick.optString("playing"),select=tick.optString("selected");boolean change=!active.equals(playing)||!select.equals(selected);playing=active;selected=select;
        double duration=tick.optDouble("duration",0),time=tick.optDouble("time",0);try{state.put("duration",duration);}catch(JSONException ignored){}
        if(!seeking&&duration>0){int progress=(int)(100000*time/duration);seek.setProgress(progress,motion.enabled()&&Math.abs(progress-seek.getProgress())<10000);}play.setText(tick.optBoolean("paused")?"▷":"Ⅱ");clock.setText(String.format(Locale.ROOT,"%02d:%02d",(int)time/60,(int)time%60));mute.setText(tick.optBoolean("muted")?"×":"♪");rate.setText(tick.optString("rate","1")+"×");
        if(change)for(int i=0;i<cueList.getChildCount();i++)cues.highlight(cueList.getChildAt(i));
        if(!editor||!tab.equals("subs")||!tick.optBoolean("follow")||editDialog!=null||System.currentTimeMillis()<manualUntil||active.isEmpty()||active.equals(lastFollow))return;
        int index=cues.index(active);if(index>=0){lastFollow=active;cueList.setSelectionFromTop(index,Math.min(dp(48),Math.round(cueList.getHeight()*.12f)));}
    }
    private AlertDialog dialog(String name,JSONArray controls,Runnable cancel){
        ListView list=list();Rows rows=new Rows();rows.set(controls);list.setAdapter(rows);lastDialogRows=rows;
        AlertDialog dialog=new AlertDialog.Builder(activity).setTitle(name).setView(list).setNegativeButton("关闭",(d,w)->{blur();if(cancel!=null)cancel.run();}).create();
        dialog.setOnCancelListener(d->{blur();if(cancel!=null)cancel.run();});dialog.show();
        dialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE|WindowManager.LayoutParams.SOFT_INPUT_STATE_ALWAYS_HIDDEN);View decor=dialog.getWindow().getDecorView();decor.setFocusableInTouchMode(true);decor.requestFocus();
        dialog.getWindow().setBackgroundDrawable(background(SURFACE,0xff666666));dialog.getWindow().setLayout(-1,Math.max(dp(200),Math.min(root.getHeight()-dp(70),dp(600))));return dialog;
    }
    private void syncModal(JSONObject data){
        String id=data==null?"":data.optString("id");
        String contents=data==null?"":String.valueOf(data.optJSONArray("controls"));
        if(id.equals(modalId)){if(modalRows!=null&&!contents.equals(modalContents)&&!(modal.getCurrentFocus() instanceof EditText)){modalRows.set(data.optJSONArray("controls"));modalContents=contents;}return;}
        if(modal!=null){modal.dismiss();modal=null;}modalId=id;
        modalRows=null;modalContents=contents;
        if(data!=null){modal=dialog(data.optString("title","操作"),data.optJSONArray("controls"),()->command(obj("kind","dismiss","id",id)));modalRows=lastDialogRows;}
    }
    private void syncEdit(JSONObject data){
        String id=data==null?"":data.optString("id");if(id.equals(editId))return;
        if(editDialog!=null){editDialog.dismiss();editDialog=null;}editId=id;if(data==null)return;
        LinearLayout fields=column();fields.setPadding(dp(16),dp(8),dp(16),dp(16));
        EditText start=input(fields,"开始时间",data.optString("start"),false),end=input(fields,"结束时间",data.optString("end"),false);
        EditText l1=input(fields,"中文",data.optString("l1"),true),l2=input(fields,"英文",data.optString("l2"),true);
        ScrollView scroll=new ScrollView(activity);scroll.addView(fields);
        editDialog=new AlertDialog.Builder(activity).setTitle("编辑字幕").setView(scroll).setPositiveButton("保存",null).setNegativeButton("取消",(d,w)->{blur();send("editCancel");}).create();
        editDialog.setOnCancelListener(d->{blur();send("editCancel");});editDialog.show();editDialog.getWindow().setBackgroundDrawable(background(SURFACE,0xff666666));
        editDialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{command(obj("kind","editApply","l1",l1.getText().toString(),"l2",l2.getText().toString(),"start",start.getText().toString(),"end",end.getText().toString()));blur();});
        editDialog.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
    }
    private EditText input(LinearLayout parent,String label,String value,boolean multi){parent.addView(text(label,12,MUTED));EditText input=new EditText(activity);input.setTextColor(FG);input.setTextSize(16);input.setText(value);input.setSingleLine(!multi);input.setMinHeight(dp(48));input.setPadding(dp(10),dp(8),dp(10),dp(8));input.setBackground(background(SURFACE,0xff666666));parent.addView(input,new LinearLayout.LayoutParams(-1,-2));return input;}
    boolean back(){if(editDialog!=null){send("editCancel");return true;}if(modal!=null){command(obj("kind","dismiss","id",modalId));return true;}if(filterDialog!=null&&filterDialog.isShowing()){filterDialog.dismiss();return true;}blur();send("back");return true;}
    void visible(boolean visible){motion.visible(visible);}
    void close(){closed=true;motion.close();handler.removeCallbacksAndMessages(null);if(modal!=null)modal.dismiss();if(editDialog!=null)editDialog.dismiss();if(filterDialog!=null)filterDialog.dismiss();}

    private final class Cues extends BaseAdapter {
        private JSONArray data=new JSONArray();
        void set(JSONArray next){if(next==null)next=new JSONArray();if(data.toString().equals(next.toString()))return;data=next;notifyDataSetChanged();}
        int index(String id){for(int i=0;i<data.length();i++)if(data.optJSONObject(i).optString("id").equals(id))return i;return -1;}
        public int getCount(){return data.length();}public Object getItem(int i){return data.optJSONObject(i);}public long getItemId(int i){return i;}
        void highlight(View view){String id=String.valueOf(view.getTag());view.setActivated(id.equals(playing)||id.equals(selected));}
        public View getView(int position,View old,ViewGroup parent){
            JSONObject item=data.optJSONObject(position);String id=item.optString("id");LinearLayout card=column();card.setTag(id);card.setPadding(dp(12),dp(8),dp(12),dp(8));card.setBackground(background(SURFACE,0xff555555));
            LinearLayout top=row();TextView times=text(item.optString("start")+"  →  "+item.optString("end"),11,MUTED);top.addView(times,new LinearLayout.LayoutParams(0,dp(36),1));
            times.setOnClickListener(v->command(obj("kind","seekCue","item",id)));
            Button edit=button("编辑",()->command(obj("kind","edit","item",id)));top.addView(edit,new LinearLayout.LayoutParams(dp(66),dp(44)));card.addView(top);
            TextView role=text(item.optString("role"),12,ACCENT);try{role.setTextColor(Color.parseColor(item.optString("color")));}catch(Exception ignored){}if(!role.getText().toString().isEmpty())card.addView(role);
            String meta=item.optString("style")+(item.optString("confidence").isEmpty()?"":" · "+item.optString("confidence"));if(!meta.isEmpty())card.addView(text(meta,11,MUTED));if(!item.optString("bad").isEmpty())card.addView(text("⚠ "+item.optString("bad"),12,0xffffbb44));
            TextView l1=text(item.optString("l1"),16,FG),l2=text(item.optString("l2"),14,MUTED);l1.setPadding(0,dp(5),0,dp(5));l2.setPadding(0,0,0,dp(8));if(!item.optString("l1").isEmpty())card.addView(l1);if(!item.optString("l2").isEmpty())card.addView(l2);
            card.setOnClickListener(v->command(obj("kind","select","item",id)));card.setOnLongClickListener(v->{command(obj("kind","menu","item",id));return true;});press(card);highlight(card);return card;
        }
    }
    private final class Rows extends BaseAdapter {
        private JSONArray data=new JSONArray();
        private final Map<String,Integer> progressValues=new HashMap<>();
        void set(JSONArray next){if(next==null)next=new JSONArray();if(data.toString().equals(next.toString()))return;data=next;Set<String> keep=new HashSet<>();for(int i=0;i<data.length();i++){JSONObject node=data.optJSONObject(i);if(node!=null&&node.optString("kind").equals("progress"))keep.add(node.optString("id",String.valueOf(i)));}progressValues.keySet().retainAll(keep);notifyDataSetChanged();}
        public int getCount(){return data.length();}public Object getItem(int i){return data.optJSONObject(i);}public long getItemId(int i){return i;}
        public View getView(int position,View old,ViewGroup parent){
            JSONObject node=data.optJSONObject(position);String kind=node.optString("kind"),id=node.optString("id"),name=node.optString("text");
            LinearLayout wrap=column();wrap.setPadding(dp(2),dp(3),dp(2),dp(3));
            if(kind.equals("button")){Button b=button(name,()->command(node.has("command")?node.optJSONObject("command"):obj("kind","click","id",id)));b.setEnabled(!node.optBoolean("disabled"));if(node.optString("tone").equals("primary"))b.setBackground(background(ACCENT,ACCENT));b.setActivated(node.optBoolean("active"));if(node.optBoolean("active"))b.setTextColor(0xff48b8ff);if(node.optBoolean("context"))b.setOnLongClickListener(v->{command(obj("kind","context","id",id));return true;});wrap.addView(b,new LinearLayout.LayoutParams(-1,dp(48)));}
            else if(kind.equals("buttons")){
                JSONArray choices=node.optJSONArray("choices");int columns=node.optInt("columns",2);LinearLayout line=null;
                for(int i=0;choices!=null&&i<choices.length();i++){if(i%columns==0){line=row();wrap.addView(line);}JSONObject choice=choices.optJSONObject(i);String target=choice.optString("id");Button b=button(choice.optString("text"),()->command(obj("kind","click","id",target)));b.setTextSize(13);b.setPadding(dp(4),0,dp(4),0);b.setEnabled(!choice.optBoolean("disabled"));if(choice.optString("tone").equals("primary"))b.setBackground(background(ACCENT,ACCENT));b.setActivated(choice.optBoolean("active"));if(choice.optBoolean("active"))b.setTextColor(0xff48b8ff);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(0,dp(48),1);p.setMargins(dp(2),dp(2),dp(2),dp(2));line.addView(b,p);}
            }
            else if(kind.equals("video")){
                String mediaId=node.optString("mediaId");if(mediaId.matches("[0-9a-f-]{36}")){VideoView preview=new VideoView(activity);preview.setVideoPath(new java.io.File(activity.getFilesDir(),"media/"+mediaId+".media").getPath());MediaController controls=new MediaController(activity);preview.setMediaController(controls);controls.setAnchorView(preview);preview.setOnPreparedListener(media->preview.seekTo(1));wrap.addView(preview,new LinearLayout.LayoutParams(-1,dp(200)));}
            }
            else if(kind.equals("heading")){TextView t=text(name,node.optBoolean("large")?30:20,FG);t.setTypeface(Typeface.create("sans-serif-light",Typeface.NORMAL));t.setPadding(0,dp(16),0,dp(6));wrap.addView(t);}
            else if(kind.equals("text")){TextView t=text(name,14,MUTED);t.setTextIsSelectable(true);wrap.addView(t);}
            else if(kind.equals("divider")){View line=new View(activity);line.setBackgroundColor(0xff454545);LinearLayout.LayoutParams p=new LinearLayout.LayoutParams(-1,dp(1));p.setMargins(0,dp(8),0,dp(8));wrap.addView(line,p);}
            else if(kind.equals("check")){Switch check=new Switch(activity);check.setText(name);check.setTextColor(FG);check.setMinHeight(dp(48));check.setChecked(node.optBoolean("value"));check.setEnabled(!node.optBoolean("disabled"));check.setOnCheckedChangeListener((v,value)->{if(!applying)command(obj("kind","value","id",id,"value",value));});wrap.addView(check);}
            else if(kind.equals("input")){
                EditText input=input(wrap,name,node.optString("value"),node.optBoolean("multiline"));input.setHint(node.optString("placeholder"));input.setHintTextColor(MUTED);input.setEnabled(!node.optBoolean("disabled")&&!node.optBoolean("readonly"));
                String type=node.optString("type");if(type.equals("password"))input.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD);else if(type.equals("number"))input.setInputType(android.text.InputType.TYPE_CLASS_NUMBER|android.text.InputType.TYPE_NUMBER_FLAG_DECIMAL|android.text.InputType.TYPE_NUMBER_FLAG_SIGNED);
                input.setOnTouchListener((v,event)->{if(event.getActionMasked()==MotionEvent.ACTION_DOWN)activeInput=input;return false;});
                input.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int a,int c,int f){}public void onTextChanged(CharSequence s,int a,int b,int c){if(!applying){if(input.isFocused())activeInput=input;command(obj("kind","value","id",id,"value",s.toString(),"phase","input"));}}public void afterTextChanged(Editable e){}});
                input.setOnFocusChangeListener((v,focused)->{if(!focused){if(activeInput==input)activeInput=null;if(!applying)command(obj("kind","value","id",id,"value",input.getText().toString(),"phase","change"));}});
            }else if(kind.equals("select")){
                wrap.addView(text(name,12,MUTED));JSONArray options=node.optJSONArray("options");ArrayList<String> labels=new ArrayList<>();int active=0;if(options!=null)for(int i=0;i<options.length();i++){JSONObject option=options.optJSONObject(i);labels.add(option.optString("text"));if(option.optString("value").equals(node.optString("value")))active=i;}
                Spinner spinner=new Spinner(activity);ArrayAdapter<String> adapter=new ArrayAdapter<String>(activity,android.R.layout.simple_spinner_item,labels);adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);spinner.setAdapter(adapter);spinner.setSelection(active,false);spinner.setMinimumHeight(dp(48));spinner.setEnabled(!node.optBoolean("disabled"));final int initial=active;
                spinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener(){int previous=initial;public void onNothingSelected(android.widget.AdapterView<?> v){}public void onItemSelected(android.widget.AdapterView<?> v,View view,int index,long row){if(index!=previous&&options!=null&&!options.optJSONObject(index).optBoolean("disabled")){previous=index;command(obj("kind","value","id",id,"value",options.optJSONObject(index).optString("value")));}}});wrap.addView(spinner);
            }else if(kind.equals("range")){
                wrap.addView(text(name+" · "+node.optString("value"),12,MUTED));SeekBar bar=new SeekBar(activity);double min=node.optDouble("min",0),max=node.optDouble("max",100),step=node.optDouble("step",1);if(step<=0)step=1;final double increment=step;bar.setMax((int)Math.min(10000,Math.ceil((max-min)/step)));bar.setProgress((int)Math.round((node.optDouble("value")-min)/step));bar.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener(){public void onStartTrackingTouch(SeekBar b){}public void onStopTrackingTouch(SeekBar b){command(obj("kind","value","id",id,"value",min+b.getProgress()*increment));}public void onProgressChanged(SeekBar b,int p,boolean user){}});wrap.addView(bar,new LinearLayout.LayoutParams(-1,dp(48)));
            }else if(kind.equals("color")){Button color=button(name+"  "+node.optString("value"),()->{EditText input=new EditText(activity);input.setText(node.optString("value"));new AlertDialog.Builder(activity).setTitle(name).setView(input).setPositiveButton("确定",(d,w)->command(obj("kind","value","id",id,"value",input.getText().toString()))).setNegativeButton("取消",null).show();});wrap.addView(color);}
            else if(kind.equals("progress")){ProgressBar progress=new ProgressBar(activity,null,android.R.attr.progressBarStyleHorizontal);progress.setMax(1000);String key=node.optString("id",String.valueOf(position));int value=(int)(1000*node.optDouble("value")/Math.max(1,node.optDouble("max",1)));progress.setProgress(progressValues.containsKey(key)?progressValues.get(key):value);progress.setProgress(value,motion.enabled());progressValues.put(key,value);progress.setIndeterminate(node.optBoolean("indeterminate")&&motion.enabled());wrap.addView(progress);}
            return wrap;
        }
    }
}
