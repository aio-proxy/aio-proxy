package sparkle

import (
	"testing"

	"github.com/ebitengine/purego/objc"

	"github.com/aio-proxy/aio-proxy/desktop/internal/macos/foundation"
)

var delegateSelectors = []string{
	"supportsGentleScheduledUpdateReminders",
	"standardUserDriverShouldHandleShowingScheduledUpdate:andInImmediateFocus:",
	"standardUserDriverWillHandleShowingUpdate:forUpdate:state:",
	"standardUserDriverDidReceiveUserAttentionForUpdate:",
	"standardUserDriverWillFinishUpdateSession",
}

// fakeAppcastItem stands in for SUAppcastItem: only displayVersionString is read.
func fakeAppcastItem(t *testing.T, version string) objc.ID {
	t.Helper()
	class := objc.GetClass("AIOProxyTestAppcastItem")
	if class == 0 {
		var err error
		class, err = objc.RegisterClass("AIOProxyTestAppcastItem", objc.GetClass("NSObject"), nil, nil, []objc.MethodDef{{
			Cmd: objc.RegisterName("displayVersionString"),
			Fn:  func(objc.ID, objc.SEL) objc.ID { return foundation.NSString(version) },
		}})
		if err != nil {
			t.Fatal(err)
		}
	}
	return foundation.New(class)
}

func TestUserDriverDelegate(t *testing.T) {
	foundation.WithPool(func() {
		class, err := userDriverDelegate()
		if err != nil {
			t.Fatal(err)
		}
		delegate := foundation.New(class)
		defer foundation.Release(delegate)
		for _, selector := range delegateSelectors {
			if !foundation.RespondsTo(delegate, selector) {
				t.Errorf("delegate does not respond to %s", selector)
			}
		}

		var versions []string
		attendedCount := 0
		handlers.onAvailable = func(v string) { versions = append(versions, v) }
		handlers.onAttended = func() { attendedCount++ }
		t.Cleanup(func() { handlers.onAvailable, handlers.onAttended = nil, nil })

		item := fakeAppcastItem(t, "1.2.3")
		defer foundation.Release(item)

		if !objc.Send[bool](delegate, objc.RegisterName(delegateSelectors[0])) {
			t.Error("supportsGentleScheduledUpdateReminders = false")
		}
		should := objc.RegisterName(delegateSelectors[1])
		if !objc.Send[bool](delegate, should, item, true) {
			t.Error("should handle scheduled update in immediate focus = false")
		}
		if objc.Send[bool](delegate, should, item, false) {
			t.Error("should handle scheduled update out of focus = true")
		}

		willHandle := objc.RegisterName(delegateSelectors[2])
		delegate.Send(willHandle, true, item, objc.ID(0))
		if len(versions) != 0 {
			t.Errorf("Sparkle showing the update still reported %v", versions)
		}
		delegate.Send(willHandle, false, item, objc.ID(0))
		if len(versions) != 1 || versions[0] != "1.2.3" {
			t.Errorf("versions = %v, want [1.2.3]", versions)
		}

		delegate.Send(objc.RegisterName(delegateSelectors[3]), item)
		delegate.Send(objc.RegisterName(delegateSelectors[4]))
		if attendedCount != 2 {
			t.Errorf("attended %d times, want 2", attendedCount)
		}
	})
}

func TestLoadRefusesEmptyPath(t *testing.T) {
	if load("") {
		t.Error(`load("") = true`)
	}
	if load("/nonexistent/Sparkle.framework/Sparkle") {
		t.Error("load of a missing framework = true")
	}
}
