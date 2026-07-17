package usage

import (
	"context"
	"testing"
)

func TestWithReasoningEffortFromRequest(t *testing.T) {
	tests := []struct {
		name  string
		body  string
		model string
		want  string
	}{
		{name: "responses nested", body: `{"reasoning":{"effort":"HIGH"}}`, model: "gpt-5", want: "high"},
		{name: "chat completions flat", body: `{"reasoning_effort":"x-high"}`, model: "gpt-5", want: "xhigh"},
		{name: "nested wins", body: `{"reasoning":{"effort":"low"},"reasoning_effort":"high"}`, model: "gpt-5", want: "low"},
		{name: "gpt 5.6 keeps max", body: `{"reasoning":{"effort":"Max"}}`, model: "openai/gpt-5.6-sol", want: "max"},
		{name: "other model maps max", body: `{"reasoning":{"effort":"max"}}`, model: "gpt-5", want: "xhigh"},
		{name: "minimal omitted", body: `{"reasoning":{"effort":"minimal"}}`, model: "gpt-5", want: ""},
		{name: "invalid json", body: `{`, model: "gpt-5", want: ""},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := WithReasoningEffortFromRequest(context.Background(), []byte(test.body), test.model)
			if got := ReasoningEffortFromContext(ctx); got != test.want {
				t.Fatalf("ReasoningEffortFromContext() = %q, want %q", got, test.want)
			}
		})
	}
}
