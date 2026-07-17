package logging

import (
	"sync"
	"time"
)

// ResponseTimingGinKey is the Gin context key for per-request response timing.
const ResponseTimingGinKey = "CPA_RESPONSE_TIMING"

// ResponseTiming stores response milestones shared by middleware and usage reporting.
type ResponseTiming struct {
	mu             sync.RWMutex
	firstChunkTime time.Time
}

// NewResponseTiming creates an empty response timing tracker.
func NewResponseTiming() *ResponseTiming {
	return &ResponseTiming{}
}

// MarkFirstChunk records the first non-zero response chunk timestamp once.
func (t *ResponseTiming) MarkFirstChunk(timestamp time.Time) {
	if t == nil || timestamp.IsZero() {
		return
	}
	t.mu.Lock()
	if t.firstChunkTime.IsZero() {
		t.firstChunkTime = timestamp
	}
	t.mu.Unlock()
}

// FirstChunkTimestamp returns the captured first response chunk timestamp.
func (t *ResponseTiming) FirstChunkTimestamp() time.Time {
	if t == nil {
		return time.Time{}
	}
	t.mu.RLock()
	timestamp := t.firstChunkTime
	t.mu.RUnlock()
	return timestamp
}
