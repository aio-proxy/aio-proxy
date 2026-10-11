package panel

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The software renderer combines every rounded clip, but Metal shapes only the innermost one.
// Exercise the real Metal shader with the panel's scene; CapturePage alone cannot guard this bug.
// The isolated SDK copy adds a test-only adapter without modifying the dependency or shipped app.
func TestStickyTopCornersOnMetal(t *testing.T) {
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	list := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "github.com/egoist/mygo")
	list.Dir = root
	sdkBytes, err := list.Output()
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	sdk := filepath.Join(work, "mygo")
	if err := os.CopyFS(sdk, os.DirFS(strings.TrimSpace(string(sdkBytes)))); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sdk, "ui", "omp_metal_test_adapter.go"), []byte(metalTestAdapter), 0600); err != nil {
		t.Fatal(err)
	}
	project := filepath.Join(work, "probe")
	if err := os.Mkdir(project, 0700); err != nil {
		t.Fatal(err)
	}
	mod := "module github.com/aio-proxy/aio-proxy/desktop/gpucheck\n\ngo 1.27.1\n\nrequire github.com/aio-proxy/aio-proxy/desktop v0.0.0\nreplace github.com/aio-proxy/aio-proxy/desktop => " + root + "\nreplace github.com/egoist/mygo => " + sdk + "\n"
	if err := os.WriteFile(filepath.Join(project, "go.mod"), []byte(mod), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "main.go"), []byte(metalCornerConsumer), 0600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("go", "run", "-mod=mod", ".")
	cmd.Dir = project
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "AIO_GPU_FIXTURE="+filepath.Join(root, "../packages/types/src/desktop-summary/fixtures/v1.json"))
	output, err := cmd.CombinedOutput()
	if err != nil {
		if strings.Contains(string(output), "metal: no Metal device") {
			t.Skip("Metal device unavailable; native GPU regression requires GPU hardware")
		}
		t.Fatalf("Metal corner regression: %v\n%s", err, output)
	}
}

const metalTestAdapter = `package ui
import (
 "image"
 "github.com/egoist/mygo/internal/gpu/metal"
 "github.com/egoist/mygo/internal/scene"
)
func OMPMetalCornerProbe(view func(*Context), width,height int, exercise func(*Tester)) (*image.RGBA,Rect,error) {
 tt:=NewTester(view,width,height);exercise(tt)
 var viewport Rect
 for _,op:=range tt.h.last.Ops {if op.Kind==scene.OpPushClip && op.Rect.X==8 && op.Rect.W==344 {viewport=Rect{X:op.Rect.X,Y:op.Rect.Y,W:op.Rect.W,H:op.Rect.H};break}}
 pixels,err:=metal.RenderOffscreen(tt.h.last);if err!=nil {return nil,viewport,err}
 for i:=range len(pixels)/4 {n:=i*4;pixels[n],pixels[n+2]=pixels[n+2],pixels[n]}
 return &image.RGBA{Pix:pixels,Stride:width*4,Rect:image.Rect(0,0,width,height)},viewport,nil
}
`
const metalCornerConsumer = `package main
import (
 "fmt"
 "os"
 "github.com/aio-proxy/aio-proxy/desktop/internal/app"
 "github.com/aio-proxy/aio-proxy/desktop/internal/install"
 "github.com/aio-proxy/aio-proxy/desktop/internal/panel"
 "github.com/aio-proxy/aio-proxy/desktop/internal/summary"
 "github.com/egoist/mygo/ui"
)
func main(){
 raw,err:=os.ReadFile(os.Getenv("AIO_GPU_FIXTURE"));if err!=nil {panic(err)}
 parsed:=summary.Parse(raw);if parsed.Kind!=summary.ParsedV1 {panic(parsed.Err)}
 for i:=range parsed.V1.Providers {parsed.V1.Providers[i].Icon=""}
 for _,dark:=range []bool{false,true} {
  m:=app.NewModel(install.PathsForHome("/tmp/aio-gpu-corner-fixture"),"")
  m.Summary=app.SummaryState{Kind:app.SummaryReady,Value:parsed.V1}
  im,viewport,err:=ui.OMPMetalCornerProbe(func(c *ui.Context){panel.Root(c,m)},360,400,func(tt *ui.Tester){
   tt.SetDark(dark);tt.SetPreferences(ui.Preferences{ReduceMotion:true,TextScale:1});tt.Scroll(100,180,0,40);tt.Frame()
  });if err!=nil {panic(err)}
  if viewport.W==0 {panic("viewport clip not found")}
  y:=int(viewport.Y)+1
  for _,x:=range []int{int(viewport.X)+1,int(viewport.X+viewport.W)-2} {
   if alpha:=im.RGBAAt(x,y).A;alpha!=0 {panic(fmt.Sprintf("Metal filled rounded corner dark=%v (%d,%d) alpha=%d",dark,x,y,alpha))}
  }
  if alpha:=im.RGBAAt(int(viewport.X+viewport.W/2),y).A;alpha!=255 {panic("sticky header center missing")}
 }
 fmt.Println("light and dark real Metal corner coverage passed")
}
`
