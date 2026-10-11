package app

// A post-action discovery receives a number at completion, outranking discoveries started mid-action.
type discoveryOrder struct{ issued, applied uint64 }

func (o *discoveryOrder) issue() uint64 { o.issued++; return o.issued }
func (o *discoveryOrder) accept(seq uint64) bool {
	if seq <= o.applied {
		return false
	}
	o.applied = seq
	return true
}
