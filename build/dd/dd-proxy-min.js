YUI.add("dd-proxy",function(A){var H=A.DD.DDM,B="node",G="dragNode",C="proxy",I="owner",D=true;var F=function(J){F.superclass.constructor.apply(this,arguments);};F.NAME="DDProxy";F.NS="proxy";F.ATTRS={moveOnEnd:{value:D},resizeFrame:{value:D},positionProxy:{value:D},borderStyle:{value:"1px solid #808080"},owner:{writeOnce:D,value:false}};var E={_hands:null,_init:function(){if(!H._proxy){A.on("event:ready",A.bind(this._init,this));return;}if(!this._hands){this._hands=[];}var M,N,L,J=this.get(I),K=J.get(G);if(K.compareTo(J.get(B))){if(H._proxy){J.set(G,H._proxy);}}for(M in this._hands){this._hands[M].detach();}N=H.on("ddm:start",A.bind(function(){if(H.activeDrag===J){H._setFrame(J);}},this));L=H.on("ddm:end",A.bind(function(){if(J.get("dragging")){if(this.get("moveOnEnd")){J.get(B).setXY(J.lastXY);}J.get(G).setStyle("display","none");}},this));this._hands=[N,L];},initializer:function(){this._init();},destructor:function(){var J=this.get(I);for(var K in this._hands){this._hands[K].detach();}J.set(G,J.get(B));}};A.namespace("plugin");A.extend(F,A.Base,E);A.plugin.DDProxy=F;A.mix(H,{_createFrame:function(){if(!H._proxy){H._proxy=D;var K=A.Node.create("<div></div>"),J=A.Node.get("body");K.setStyles({position:"absolute",display:"none",zIndex:"999",top:"-999px",left:"-999px"});J.insertBefore(K,J.get("firstChild"));K.set("id",A.stamp(K));K.addClass(H.CSS_PREFIX+"-proxy");H._proxy=K;}},_setFrame:function(K){var N=K.get(B),M=K.get(G),J,L="auto";if(K.proxy.get("resizeFrame")){H._proxy.setStyles({height:N.get("offsetHeight")+"px",width:N.get("offsetWidth")+"px"});}J=H.activeDrag.get("activeHandle");if(J){L=J.getStyle("cursor");}if(L=="auto"){L=H.get("dragCursor");}M.setStyles({visibility:"hidden",display:"block",cursor:L,border:K.proxy.get("borderStyle")});if(K.proxy.get("positionProxy")){M.setXY(K.nodeXY);}M.setStyle("visibility","visible");}});A.on("event:ready",A.bind(H._createFrame,H));},"@VERSION@",{requires:["dd-ddm","dd-drag"],skinnable:false});