package usagehistory

import (
	"math"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStorePersistsFiltersAndRecalculatesCost(t *testing.T) {
	dir := t.TempDir()
	recordPath := filepath.Join(dir, "usage-history.jsonl")
	pricingPath := filepath.Join(dir, "usage-pricing.json")

	store := NewStore()
	if err := store.Configure(recordPath, pricingPath); err != nil {
		t.Fatalf("configure store: %v", err)
	}
	if err := store.SetPricing(PricingConfig{
		Currency: "USD",
		Default: PricingRule{
			Enabled:             true,
			InputPerMillion:     1,
			OutputPerMillion:    2,
			ReasoningPerMillion: 3,
			CachedPerMillion:    0.5,
		},
		Models: map[string]PricingRule{},
	}); err != nil {
		t.Fatalf("set pricing: %v", err)
	}

	base := time.Date(2026, 7, 17, 8, 0, 0, 0, time.UTC)
	records := []Record{
		{
			Timestamp:    base,
			FirstTokenMs: 40,
			LatencyMs:    100,
			Source:       "account-a",
			Provider:     "openai",
			Model:        "gpt-5",
			Endpoint:     "POST /v1/responses",
			Tokens:       TokenStats{InputTokens: 1000, OutputTokens: 500, CachedTokens: 800, TotalTokens: 1500},
		},
		{
			Timestamp: base.Add(time.Hour),
			LatencyMs: 300,
			Source:    "account-b",
			Provider:  "anthropic",
			Model:     "claude-sonnet",
			Endpoint:  "POST /v1/messages",
			Failed:    true,
			Tokens:    TokenStats{InputTokens: 2000, OutputTokens: 1000, TotalTokens: 3000},
		},
	}
	for _, record := range records {
		if err := store.Append(record); err != nil {
			t.Fatalf("append record: %v", err)
		}
	}

	result := store.Query(Filter{Status: "success", Page: 1, PageSize: 10})
	if result.Total != 1 || len(result.Items) != 1 {
		t.Fatalf("success result = %+v, want one item", result)
	}
	if !result.Items[0].CostKnown || result.Items[0].Cost != 0.0016 {
		t.Fatalf("cost = %v known=%v, want 0.0016 known", result.Items[0].Cost, result.Items[0].CostKnown)
	}

	stats := store.Stats(Filter{Granularity: "hour"})
	if stats.TotalRequests != 2 || stats.FailedRequests != 1 || stats.TotalTokens != 4500 {
		t.Fatalf("stats totals = %+v", stats)
	}
	if stats.AverageLatencyMs != 200 || len(stats.Trend) != 2 || len(stats.Models) != 2 {
		t.Fatalf("stats aggregation = %+v", stats)
	}
	if stats.Models[1].Key != "gpt-5" || stats.Models[1].InputTokens != 1000 || stats.Models[1].OutputTokens != 500 || stats.Models[1].CachedTokens != 800 {
		t.Fatalf("model token breakdown = %+v", stats.Models)
	}
	if stats.Models[1].Group != "openai" || stats.Accounts[1].Group != "openai" {
		t.Fatalf("provider groups = models %+v accounts %+v", stats.Models, stats.Accounts)
	}

	reloaded := NewStore()
	if err := reloaded.Configure(recordPath, pricingPath); err != nil {
		t.Fatalf("reload store: %v", err)
	}
	if got := reloaded.Query(Filter{Page: 1, PageSize: 10}); got.Total != 2 {
		t.Fatalf("reloaded total = %d, want 2", got.Total)
	}
	if got := reloaded.Query(Filter{Status: "success", Page: 1, PageSize: 10}); got.Items[0].FirstTokenMs != 40 {
		t.Fatalf("reloaded first token latency = %d, want 40", got.Items[0].FirstTokenMs)
	}
}

func TestStoreLoadsLegacyRecordWithoutFirstTokenLatency(t *testing.T) {
	dir := t.TempDir()
	recordPath := filepath.Join(dir, "usage-history.jsonl")
	legacy := []byte(`{"id":1,"timestamp":"2026-07-17T08:00:00Z","latency_ms":250,"tokens":{"input_tokens":1,"output_tokens":1,"reasoning_tokens":0,"cached_tokens":0,"total_tokens":2},"failed":false,"fail":{"status_code":200},"provider":"openai","model":"gpt-5"}` + "\n")
	if err := os.WriteFile(recordPath, legacy, 0o600); err != nil {
		t.Fatalf("write legacy record: %v", err)
	}

	store := NewStore()
	if err := store.Configure(recordPath, filepath.Join(dir, "usage-pricing.json")); err != nil {
		t.Fatalf("configure store: %v", err)
	}
	result := store.Query(Filter{Page: 1, PageSize: 10})
	if result.Total != 1 || result.Items[0].FirstTokenMs != 0 {
		t.Fatalf("legacy record = %+v, want zero first token latency", result)
	}
}

func TestBuiltinPricingMatchesSub2CostCalculation(t *testing.T) {
	record := Record{
		Provider: "codex",
		Model:    "gpt-5.6-sol",
		Tokens: TokenStats{
			InputTokens:     113844,
			OutputTokens:    1040,
			ReasoningTokens: 427,
			CachedTokens:    112128,
			TotalTokens:     114884,
		},
	}
	priced := withCost(record, defaultPricingConfig())
	if !priced.CostKnown || math.Abs(priced.Cost-0.095844) > 1e-9 {
		t.Fatalf("cost = %.9f known=%v, want 0.095844 known", priced.Cost, priced.CostKnown)
	}
}

func TestBuiltinPricingAppliesLongContextTierAbove272K(t *testing.T) {
	base := withCost(Record{
		Model:  "gpt-5.4",
		Tokens: TokenStats{InputTokens: 272000, TotalTokens: 272000},
	}, defaultPricingConfig())
	long := withCost(Record{
		Model:  "gpt-5.4",
		Tokens: TokenStats{InputTokens: 272001, TotalTokens: 272001},
	}, defaultPricingConfig())
	if math.Abs(base.Cost-0.68) > 1e-9 {
		t.Fatalf("base cost = %.9f, want 0.68", base.Cost)
	}
	if math.Abs(long.Cost-1.360005) > 1e-9 {
		t.Fatalf("long context cost = %.9f, want 1.360005", long.Cost)
	}
}
