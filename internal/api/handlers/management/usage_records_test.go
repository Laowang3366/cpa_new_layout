package management

import (
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/redisqueue"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/usagehistory"
)

func TestGetUsageRecordsIsDurableAndDoesNotConsumeQueue(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	if err := usagehistory.Configure(filepath.Join(dir, "usage-history.jsonl"), filepath.Join(dir, "usage-pricing.json")); err != nil {
		t.Fatalf("configure usage history: %v", err)
	}
	if err := usagehistory.Append(usagehistory.Record{
		Timestamp: time.Date(2026, 7, 17, 8, 0, 0, 0, time.UTC),
		Provider:  "openai",
		Model:     "gpt-5",
		Source:    "account-a",
		Endpoint:  "POST /v1/responses",
		Tokens:    usagehistory.TokenStats{InputTokens: 1000, OutputTokens: 500, TotalTokens: 1500},
	}); err != nil {
		t.Fatalf("append usage record: %v", err)
	}

	previousQueueEnabled := redisqueue.Enabled()
	previousUsageEnabled := redisqueue.UsageStatisticsEnabled()
	redisqueue.SetEnabled(false)
	redisqueue.SetEnabled(true)
	redisqueue.SetUsageStatisticsEnabled(true)
	redisqueue.PopOldest(100)
	redisqueue.Enqueue([]byte(`{"api_key":"do-not-consume"}`))
	defer func() {
		redisqueue.SetEnabled(false)
		redisqueue.SetEnabled(previousQueueEnabled)
		redisqueue.SetUsageStatisticsEnabled(previousUsageEnabled)
		redisqueue.PopOldest(100)
	}()

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/v0/management/usage-records?page=1&page_size=10&status=success", nil)
	(&Handler{}).GetUsageRecords(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "api_key") || strings.Contains(recorder.Body.String(), "do-not-consume") {
		t.Fatalf("usage response contains queue/API key data: %s", recorder.Body.String())
	}
	var result usagehistory.ListResult
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatalf("decode usage response: %v", err)
	}
	if result.Total != 1 || len(result.Items) != 1 || result.Items[0].Model != "gpt-5" {
		t.Fatalf("usage result = %+v, want one gpt-5 record", result)
	}

	remaining := redisqueue.PopOldest(10)
	if len(remaining) != 1 || !strings.Contains(string(remaining[0]), "do-not-consume") {
		t.Fatalf("queue after usage query = %q, want original item", remaining)
	}
}

func TestGetUsageRecordStatsCalculatesConfiguredCost(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := t.TempDir()
	if err := usagehistory.Configure(filepath.Join(dir, "usage-history.jsonl"), filepath.Join(dir, "usage-pricing.json")); err != nil {
		t.Fatalf("configure usage history: %v", err)
	}
	if err := usagehistory.SetPricing(usagehistory.PricingConfig{
		Currency: "USD",
		Default: usagehistory.PricingRule{
			Enabled:          true,
			InputPerMillion:  1,
			OutputPerMillion: 2,
		},
		Models: map[string]usagehistory.PricingRule{},
	}); err != nil {
		t.Fatalf("set usage pricing: %v", err)
	}
	if err := usagehistory.Append(usagehistory.Record{
		Timestamp: time.Date(2026, 7, 17, 8, 0, 0, 0, time.UTC),
		LatencyMs: 200,
		Provider:  "openai",
		Model:     "gpt-5",
		Tokens:    usagehistory.TokenStats{InputTokens: 1000, OutputTokens: 500, TotalTokens: 1500},
	}); err != nil {
		t.Fatalf("append usage record: %v", err)
	}

	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/v0/management/usage-records/stats?granularity=hour", nil)
	(&Handler{}).GetUsageRecordStats(ctx)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d body=%s", recorder.Code, http.StatusOK, recorder.Body.String())
	}
	var stats usagehistory.Stats
	if err := json.Unmarshal(recorder.Body.Bytes(), &stats); err != nil {
		t.Fatalf("decode stats response: %v", err)
	}
	if stats.TotalRequests != 1 || stats.PricedRequests != 1 || stats.UnpricedRequests != 0 {
		t.Fatalf("stats = %+v, want one priced request", stats)
	}
	if math.Abs(stats.TotalCost-0.002) > 0.0000001 {
		t.Fatalf("total cost = %v, want 0.002", stats.TotalCost)
	}
}
