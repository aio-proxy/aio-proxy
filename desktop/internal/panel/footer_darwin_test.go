package panel

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// A real AppKit tracking loop must start after the native surface event returns.
// Choosing an enabled command dispatches once; unavailable commands remain disabled.
func TestFooterOpensNativeMenuAfterInput(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	project := t.TempDir()
	mod := "module github.com/aio-proxy/aio-proxy/desktop/menucheck\n\ngo 1.27.1\n\nrequire github.com/aio-proxy/aio-proxy/desktop v0.0.0\nreplace github.com/aio-proxy/aio-proxy/desktop => " + root + "\n"
	if err := os.WriteFile(filepath.Join(project, "go.mod"), []byte(mod), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "main.go"), []byte(nativeFooterConsumer), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "go", "run", "-mod=mod", ".")
	cmd.Dir = project
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("native footer regression: %v\n%s", err, output)
	}
}

const nativeFooterConsumer = `package main

import (
 "fmt"
 "os"
 "structs"
 "time"

 "github.com/aio-proxy/aio-proxy/desktop/internal/app"
 "github.com/aio-proxy/aio-proxy/desktop/internal/connect/discovery"
 "github.com/aio-proxy/aio-proxy/desktop/internal/install"
 "github.com/aio-proxy/aio-proxy/desktop/internal/macos/foundation"
 "github.com/aio-proxy/aio-proxy/desktop/internal/menubar"
 "github.com/aio-proxy/aio-proxy/desktop/internal/panel"
 "github.com/aio-proxy/aio-proxy/desktop/internal/tray"
 "github.com/ebitengine/purego"
 "github.com/ebitengine/purego/objc"
 "github.com/egoist/mygo"
)

type point struct { _ structs.HostLayout; X,Y float64 }
var sendMouse func(objc.ID,objc.SEL,uint64,point,uint64,float64,int64,objc.ID,int64,int64,float64) objc.ID
var sendTimer func(objc.ID,objc.SEL,float64,objc.ID,objc.SEL,objc.ID,bool) objc.ID
var observer objc.ID
var nativeWindow objc.ID
var selected, opened int
var handlingInput bool
func s(name string) objc.SEL { return objc.RegisterName(name) }
func require(ok bool, message string) { if !ok { panic(message) } }

func surface(view objc.ID) objc.ID {
 if objc.Send[bool](view,s("isKindOfClass:"),objc.GetClass("MyGoSurfaceView")) { return view }
 children:=view.Send(s("subviews"))
 for i,n:=uintptr(0),objc.Send[uintptr](children,s("count"));i<n;i++ { if found:=surface(children.Send(s("objectAtIndex:"),i));found!=0 { return found } }
 return 0
}
func clickFooter() {
 if nativeWindow==0 {
  windows:=objc.ID(objc.GetClass("NSApplication")).Send(s("sharedApplication")).Send(s("windows"))
  for i,n:=uintptr(0),objc.Send[uintptr](windows,s("count"));i<n;i++ { w:=windows.Send(s("objectAtIndex:"),i);if foundation.GoString(w.Send(s("title")))=="AIO Proxy" { nativeWindow=w.Send(s("retain"));break } }
 }
 require(nativeWindow!=0,"panel window missing")
 v:=surface(nativeWindow.Send(s("contentView")));require(v!=0,"native GPU surface missing")
 // The surface is flipped; NSEvent's location is in the unflipped window coordinates.
 number:=objc.Send[int64](nativeWindow,s("windowNumber"))
 handlingInput=true
 for _,typ:=range []uint64{1,2} {
  ev:=sendMouse(objc.ID(objc.GetClass("NSEvent")),s("mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:"),typ,point{X:332,Y:20},0,0,number,0,1,1,1)
  method:="mouseDown:";if typ==2 {method="mouseUp:"};v.Send(s(method),ev)
 }
 // Flush the real surface frame while guarding both input and rendering reentrancy.
 v.Send(s("updateLayer"))
 handlingInput=false
}
func schedule(menu objc.ID) {
 timer:=sendTimer(objc.ID(objc.GetClass("NSTimer")),s("timerWithTimeInterval:target:selector:userInfo:repeats:"),0.25,observer,s("choose:"),menu,false)
 loop:=objc.ID(objc.GetClass("NSRunLoop")).Send(s("mainRunLoop"))
 loop.Send(s("addTimer:forMode:"),timer,foundation.NSString("NSEventTrackingRunLoopMode"))
}
func main() {
 lib,err:=purego.Dlopen("/usr/lib/libobjc.A.dylib",purego.RTLD_NOW|purego.RTLD_GLOBAL);if err!=nil {panic(err)}
 addr,err:=purego.Dlsym(lib,"objc_msgSend");if err!=nil {panic(err)};purego.RegisterFunc(&sendMouse,addr);purego.RegisterFunc(&sendTimer,addr)
 mygo.App.SetName("AIO Footer Menu Probe")
 mygo.App.SetActivationPolicy(mygo.ActivationPolicyAccessory)
 mygo.App.OnWindowAllClosed(func(){})
 home,err:=os.MkdirTemp("","aio-footer-menu-probe-");if err!=nil {panic(err)};defer os.RemoveAll(home)
 m:=app.NewModel(install.PathsForHome(home),"")
 m.Discovery=&discovery.Discovery{}
 m.CheckUpdates=func(){selected++}
 m.Quit=mygo.App.Quit
 cls,err:=objc.RegisterClass("AIOFooterMenuProbe",objc.GetClass("NSObject"),nil,nil,[]objc.MethodDef{
  {Cmd:s("tracking:"),Fn:func(_ objc.ID,_ objc.SEL,note objc.ID){
   menu:=note.Send(s("object"));opened++
   require(!handlingInput,"AppKit tracking re-entered the surface input handler")
   require(objc.Send[bool](nativeWindow,s("isVisible")),"panel closed when menu opened")
   first:=menu.Send(s("itemAtIndex:"),uintptr(0));require(!objc.Send[bool](first,s("isEnabled")),"unavailable Dashboard command enabled")
   schedule(menu)
  }},
  {Cmd:s("choose:"),Fn:func(_ objc.ID,_ objc.SEL,timer objc.ID){
   menu:=timer.Send(s("userInfo"))
   display:=objc.ID(0)
   for i,n:=uintptr(0),objc.Send[uintptr](menu,s("numberOfItems"));i<n;i++ {it:=menu.Send(s("itemAtIndex:"),i);if foundation.GoString(it.Send(s("title")))=="Menu Bar Display" {display=it.Send(s("submenu"));break}}
   require(display!=0,"Menu Bar Display submenu missing")
   require(objc.Send[bool](display.Send(s("itemAtIndex:"),uintptr(2)),s("isEnabled")),"cost metric disabled before two are selected")
   require(objc.Send[bool](display.Send(s("itemAtIndex:"),uintptr(3)),s("isEnabled")),"in-flight metric disabled before two are selected")
   display.Send(s("performActionForItemAtIndex:"),uintptr(0))
   require(m.MenuBarDisplay.Has(menubar.TodayTokens)&&!m.MenuBarDisplay.Has(menubar.TokensPerSecond),"native display selection did not toggle independently")
   loaded,err:=menubar.Load(m.Paths.Support);if err!=nil {panic(err)}
   require(loaded==m.MenuBarDisplay,"native display selection was not persisted")
   found:=false
   for i,n:=uintptr(0),objc.Send[uintptr](menu,s("numberOfItems"));i<n;i++ {it:=menu.Send(s("itemAtIndex:"),i);if foundation.GoString(it.Send(s("title")))=="Check for Updates…" {menu.Send(s("performActionForItemAtIndex:"),i);found=true;break}}
   require(found,"update command missing");require(selected==opened,"native command was not dispatched once per opening")
   menu.Send(s("cancelTracking"))
  }},
  {Cmd:s("ended:"),Fn:func(_ objc.ID,_ objc.SEL,note objc.ID){
   go mygo.RunOnMain(func(){
    require(opened==1&&selected==1,"duplicate menu opening or command")
    fmt.Println("native footer menu opened after input; disabled command guarded; selection dispatched once")
    mygo.App.Quit()
   })
  }},
 });if err!=nil {panic(err)}
 mygo.App.WhenReady(func(){
  observer=objc.ID(cls).Send(s("new"))
  center:=objc.ID(objc.GetClass("NSNotificationCenter")).Send(s("defaultCenter"))
  center.Send(s("addObserver:selector:name:object:"),observer,s("tracking:"),foundation.NSString("NSMenuDidBeginTrackingNotification"),objc.ID(0))
  center.Send(s("addObserver:selector:name:object:"),observer,s("ended:"),foundation.NSString("NSMenuDidEndTrackingNotification"),objc.ID(0))
  status,err:=tray.New(m,func(){},func(){});if err!=nil {panic(err)}
  m.Changed=func(){status.Sync(m)}
  go func(){time.Sleep(500*time.Millisecond);mygo.RunOnMain(func(){panel.Toggle(m,status.Icon)});time.Sleep(500*time.Millisecond);mygo.RunOnMain(clickFooter)}()
 })
 go func(){time.Sleep(8*time.Second);fmt.Fprintln(os.Stderr,"native footer menu probe timed out");os.Exit(1)}()
 if err:=mygo.App.Run();err!=nil {panic(err)}
}
`
