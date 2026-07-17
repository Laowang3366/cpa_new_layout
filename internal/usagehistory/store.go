package usagehistory

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	defaultPageSize              = 50
	maxPageSize                  = 200
	maxRecords                   = 100000
	longContextInputTokenCutover = 272000
)

type TokenStats struct {
	InputTokens     int64 `json:"input_tokens"`
	OutputTokens    int64 `json:"output_tokens"`
	ReasoningTokens int64 `json:"reasoning_tokens"`
	CachedTokens    int64 `json:"cached_tokens"`
	TotalTokens     int64 `json:"total_tokens"`
}

type Failure struct {
	StatusCode int    `json:"status_code"`
	Body       string `json:"body,omitempty"`
}

type Record struct {
	ID              uint64     `json:"id"`
	Timestamp       time.Time  `json:"timestamp"`
	FirstTokenMs    int64      `json:"first_token_ms"`
	LatencyMs       int64      `json:"latency_ms"`
	Source          string     `json:"source,omitempty"`
	ReasoningEffort string     `json:"reasoning_effort,omitempty"`
	AuthIndex       string     `json:"auth_index,omitempty"`
	Tokens          TokenStats `json:"tokens"`
	Failed          bool       `json:"failed"`
	Fail            Failure    `json:"fail"`
	Provider        string     `json:"provider"`
	Model           string     `json:"model"`
	Alias           string     `json:"alias,omitempty"`
	Endpoint        string     `json:"endpoint,omitempty"`
	AuthType        string     `json:"auth_type,omitempty"`
	RequestID       string     `json:"request_id,omitempty"`
	Cost            float64    `json:"cost,omitempty"`
	CostKnown       bool       `json:"cost_known"`
}

type PricingRule struct {
	Enabled             bool    `json:"enabled"`
	InputPerMillion     float64 `json:"input_per_million"`
	OutputPerMillion    float64 `json:"output_per_million"`
	ReasoningPerMillion float64 `json:"reasoning_per_million"`
	CachedPerMillion    float64 `json:"cached_per_million"`
}

type PricingConfig struct {
	Currency string                 `json:"currency"`
	Default  PricingRule            `json:"default"`
	Models   map[string]PricingRule `json:"models"`
}

type Filter struct {
	Start       time.Time
	End         time.Time
	Model       string
	Provider    string
	Endpoint    string
	Source      string
	AuthIndex   string
	Status      string
	Search      string
	SortBy      string
	SortOrder   string
	Granularity string
	Page        int
	PageSize    int
}

type ListResult struct {
	Items    []Record `json:"items"`
	Total    int      `json:"total"`
	Page     int      `json:"page"`
	PageSize int      `json:"page_size"`
}

type Breakdown struct {
	Key          string  `json:"key"`
	Requests     int64   `json:"requests"`
	Failures     int64   `json:"failures"`
	Tokens       int64   `json:"tokens"`
	InputTokens  int64   `json:"input_tokens"`
	OutputTokens int64   `json:"output_tokens"`
	CachedTokens int64   `json:"cached_tokens"`
	Cost         float64 `json:"cost"`
	CostKnown    bool    `json:"cost_known"`
}

type TrendPoint struct {
	Timestamp time.Time `json:"timestamp"`
	Requests  int64     `json:"requests"`
	Failures  int64     `json:"failures"`
	Tokens    int64     `json:"tokens"`
	Cost      float64   `json:"cost"`
	CostKnown bool      `json:"cost_known"`
}

type Stats struct {
	TotalRequests    int64        `json:"total_requests"`
	SuccessRequests  int64        `json:"success_requests"`
	FailedRequests   int64        `json:"failed_requests"`
	InputTokens      int64        `json:"input_tokens"`
	OutputTokens     int64        `json:"output_tokens"`
	ReasoningTokens  int64        `json:"reasoning_tokens"`
	CachedTokens     int64        `json:"cached_tokens"`
	TotalTokens      int64        `json:"total_tokens"`
	TotalCost        float64      `json:"total_cost"`
	PricedRequests   int64        `json:"priced_requests"`
	UnpricedRequests int64        `json:"unpriced_requests"`
	AverageLatencyMs float64      `json:"average_latency_ms"`
	Models           []Breakdown  `json:"models"`
	Providers        []Breakdown  `json:"providers"`
	Endpoints        []Breakdown  `json:"endpoints"`
	Accounts         []Breakdown  `json:"accounts"`
	Trend            []TrendPoint `json:"trend"`
}

type Store struct {
	mu          sync.RWMutex
	recordPath  string
	pricingPath string
	records     []Record
	nextID      uint64
	pricing     PricingConfig
}

func NewStore() *Store {
	return &Store{pricing: defaultPricingConfig()}
}

func defaultPricingConfig() PricingConfig {
	return PricingConfig{
		Currency: "USD",
		Models:   make(map[string]PricingRule),
	}
}

func (s *Store) Configure(recordPath, pricingPath string) error {
	if s == nil {
		return errors.New("usage history store unavailable")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	s.recordPath = strings.TrimSpace(recordPath)
	s.pricingPath = strings.TrimSpace(pricingPath)
	s.records = nil
	s.nextID = 0
	s.pricing = defaultPricingConfig()

	if s.recordPath != "" {
		if err := os.MkdirAll(filepath.Dir(s.recordPath), 0o700); err != nil {
			return fmt.Errorf("create usage history directory: %w", err)
		}
		if err := s.loadRecordsLocked(); err != nil {
			return err
		}
	}
	if s.pricingPath != "" {
		if err := os.MkdirAll(filepath.Dir(s.pricingPath), 0o700); err != nil {
			return fmt.Errorf("create usage pricing directory: %w", err)
		}
		if err := s.loadPricingLocked(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) Append(record Record) error {
	if s == nil {
		return errors.New("usage history store unavailable")
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if record.Timestamp.IsZero() {
		record.Timestamp = time.Now().UTC()
	}
	if record.ID == 0 {
		s.nextID++
		record.ID = s.nextID
	} else if record.ID > s.nextID {
		s.nextID = record.ID
	}
	record.Cost = 0
	record.CostKnown = false
	s.records = append(s.records, record)

	if len(s.records) > maxRecords {
		s.records = append([]Record(nil), s.records[len(s.records)-maxRecords:]...)
		return s.rewriteRecordsLocked()
	}
	if s.recordPath == "" {
		return nil
	}
	return appendRecordLine(s.recordPath, record)
}

func (s *Store) Query(filter Filter) ListResult {
	if s == nil {
		return ListResult{Page: 1, PageSize: defaultPageSize}
	}

	filter = normalizeFilter(filter)
	records, pricing := s.snapshot(filter)
	for i := range records {
		records[i] = withCost(records[i], pricing)
	}
	sortRecords(records, filter)

	total := len(records)
	start := (filter.Page - 1) * filter.PageSize
	if start > total {
		start = total
	}
	end := start + filter.PageSize
	if end > total {
		end = total
	}

	return ListResult{
		Items:    append([]Record(nil), records[start:end]...),
		Total:    total,
		Page:     filter.Page,
		PageSize: filter.PageSize,
	}
}

func (s *Store) Stats(filter Filter) Stats {
	if s == nil {
		return Stats{}
	}

	filter = normalizeFilter(filter)
	records, pricing := s.snapshot(filter)
	models := make(map[string]*Breakdown)
	providers := make(map[string]*Breakdown)
	endpoints := make(map[string]*Breakdown)
	accounts := make(map[string]*Breakdown)
	trend := make(map[time.Time]*TrendPoint)

	var result Stats
	var latencyTotal int64
	for _, raw := range records {
		record := withCost(raw, pricing)
		result.TotalRequests++
		if record.Failed {
			result.FailedRequests++
		} else {
			result.SuccessRequests++
		}
		result.InputTokens += record.Tokens.InputTokens
		result.OutputTokens += record.Tokens.OutputTokens
		result.ReasoningTokens += record.Tokens.ReasoningTokens
		result.CachedTokens += record.Tokens.CachedTokens
		result.TotalTokens += record.Tokens.TotalTokens
		result.TotalCost += record.Cost
		if record.CostKnown {
			result.PricedRequests++
		} else {
			result.UnpricedRequests++
		}
		latencyTotal += record.LatencyMs

		addBreakdown(models, record.Model, record)
		addBreakdown(providers, record.Provider, record)
		addBreakdown(endpoints, record.Endpoint, record)
		account := record.Source
		if strings.TrimSpace(account) == "" {
			account = record.AuthIndex
		}
		addBreakdown(accounts, account, record)

		bucket := trendBucket(record.Timestamp, filter.Granularity)
		point := trend[bucket]
		if point == nil {
			point = &TrendPoint{Timestamp: bucket, CostKnown: true}
			trend[bucket] = point
		}
		point.Requests++
		if record.Failed {
			point.Failures++
		}
		point.Tokens += record.Tokens.TotalTokens
		point.Cost += record.Cost
		point.CostKnown = point.CostKnown && record.CostKnown
	}

	if result.TotalRequests > 0 {
		result.AverageLatencyMs = float64(latencyTotal) / float64(result.TotalRequests)
	}
	result.Models = sortedBreakdowns(models)
	result.Providers = sortedBreakdowns(providers)
	result.Endpoints = sortedBreakdowns(endpoints)
	result.Accounts = sortedBreakdowns(accounts)
	result.Trend = sortedTrend(trend)
	return result
}

func (s *Store) Pricing() PricingConfig {
	if s == nil {
		return defaultPricingConfig()
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return clonePricingConfig(s.pricing)
}

func (s *Store) SetPricing(pricing PricingConfig) error {
	if s == nil {
		return errors.New("usage history store unavailable")
	}
	normalized, err := normalizePricingConfig(pricing)
	if err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pricingPath != "" {
		if err := writeJSONAtomic(s.pricingPath, normalized); err != nil {
			return fmt.Errorf("save usage pricing: %w", err)
		}
	}
	s.pricing = normalized
	return nil
}

func (s *Store) snapshot(filter Filter) ([]Record, PricingConfig) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	records := make([]Record, 0, len(s.records))
	for _, record := range s.records {
		if matchesFilter(record, filter) {
			records = append(records, record)
		}
	}
	return records, clonePricingConfig(s.pricing)
}

func (s *Store) loadRecordsLocked() error {
	file, err := os.Open(s.recordPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open usage history: %w", err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var record Record
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			continue
		}
		if record.ID == 0 {
			s.nextID++
			record.ID = s.nextID
		} else if record.ID > s.nextID {
			s.nextID = record.ID
		}
		record.Cost = 0
		record.CostKnown = false
		s.records = append(s.records, record)
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read usage history: %w", err)
	}
	if len(s.records) > maxRecords {
		s.records = append([]Record(nil), s.records[len(s.records)-maxRecords:]...)
		return s.rewriteRecordsLocked()
	}
	return nil
}

func (s *Store) loadPricingLocked() error {
	data, err := os.ReadFile(s.pricingPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read usage pricing: %w", err)
	}
	var pricing PricingConfig
	if err := json.Unmarshal(data, &pricing); err != nil {
		return fmt.Errorf("parse usage pricing: %w", err)
	}
	normalized, err := normalizePricingConfig(pricing)
	if err != nil {
		return fmt.Errorf("validate usage pricing: %w", err)
	}
	s.pricing = normalized
	return nil
}

func (s *Store) rewriteRecordsLocked() error {
	if s.recordPath == "" {
		return nil
	}
	dir := filepath.Dir(s.recordPath)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".usage-history-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	writer := bufio.NewWriter(tmp)
	for _, record := range s.records {
		data, err := json.Marshal(record)
		if err != nil {
			_ = tmp.Close()
			return err
		}
		if _, err := writer.Write(append(data, '\n')); err != nil {
			_ = tmp.Close()
			return err
		}
	}
	if err := writer.Flush(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return replaceFile(tmpName, s.recordPath)
}

func appendRecordLine(path string, record Record) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = file.Write(append(data, '\n'))
	return err
}

func writeJSONAtomic(path string, value any) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".usage-pricing-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	encoder := json.NewEncoder(tmp)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return replaceFile(tmpName, path)
}

func replaceFile(source, target string) error {
	if err := os.Rename(source, target); err == nil {
		return nil
	}
	if err := os.Remove(target); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(source, target)
}

func normalizeFilter(filter Filter) Filter {
	if filter.Page <= 0 {
		filter.Page = 1
	}
	if filter.PageSize <= 0 {
		filter.PageSize = defaultPageSize
	} else if filter.PageSize > maxPageSize {
		filter.PageSize = maxPageSize
	}
	filter.Status = strings.ToLower(strings.TrimSpace(filter.Status))
	if filter.Status != "success" && filter.Status != "failed" {
		filter.Status = "all"
	}
	filter.SortBy = strings.ToLower(strings.TrimSpace(filter.SortBy))
	filter.SortOrder = strings.ToLower(strings.TrimSpace(filter.SortOrder))
	if filter.SortOrder != "asc" {
		filter.SortOrder = "desc"
	}
	if filter.Granularity != "hour" {
		filter.Granularity = "day"
	}
	return filter
}

func normalizePricingConfig(pricing PricingConfig) (PricingConfig, error) {
	pricing.Currency = strings.ToUpper(strings.TrimSpace(pricing.Currency))
	if pricing.Currency == "" {
		pricing.Currency = "USD"
	}
	if err := validatePricingRule(pricing.Default); err != nil {
		return PricingConfig{}, fmt.Errorf("default pricing: %w", err)
	}
	normalizedModels := make(map[string]PricingRule, len(pricing.Models))
	for key, rule := range pricing.Models {
		key = strings.TrimSpace(key)
		if key == "" {
			return PricingConfig{}, errors.New("model pricing key cannot be empty")
		}
		if err := validatePricingRule(rule); err != nil {
			return PricingConfig{}, fmt.Errorf("model %q pricing: %w", key, err)
		}
		normalizedModels[key] = rule
	}
	pricing.Models = normalizedModels
	return pricing, nil
}

func validatePricingRule(rule PricingRule) error {
	values := []float64{
		rule.InputPerMillion,
		rule.OutputPerMillion,
		rule.ReasoningPerMillion,
		rule.CachedPerMillion,
	}
	for _, value := range values {
		if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
			return errors.New("rates must be finite non-negative numbers")
		}
	}
	return nil
}

func clonePricingConfig(pricing PricingConfig) PricingConfig {
	clone := PricingConfig{
		Currency: pricing.Currency,
		Default:  pricing.Default,
		Models:   make(map[string]PricingRule, len(pricing.Models)),
	}
	for key, rule := range pricing.Models {
		clone.Models[key] = rule
	}
	return clone
}

func matchesFilter(record Record, filter Filter) bool {
	if !filter.Start.IsZero() && record.Timestamp.Before(filter.Start) {
		return false
	}
	if !filter.End.IsZero() && !record.Timestamp.Before(filter.End) {
		return false
	}
	if !containsFold(record.Model, filter.Model) ||
		!containsFold(record.Provider, filter.Provider) ||
		!containsFold(record.Endpoint, filter.Endpoint) ||
		!containsFold(record.Source, filter.Source) ||
		!containsFold(record.AuthIndex, filter.AuthIndex) {
		return false
	}
	if filter.Status == "success" && record.Failed {
		return false
	}
	if filter.Status == "failed" && !record.Failed {
		return false
	}
	search := strings.ToLower(strings.TrimSpace(filter.Search))
	if search == "" {
		return true
	}
	haystack := strings.ToLower(strings.Join([]string{
		record.Model,
		record.Alias,
		record.Provider,
		record.Endpoint,
		record.Source,
		record.AuthIndex,
		record.AuthType,
		record.RequestID,
	}, " "))
	return strings.Contains(haystack, search)
}

func containsFold(value, query string) bool {
	query = strings.TrimSpace(query)
	return query == "" || strings.Contains(strings.ToLower(value), strings.ToLower(query))
}

func sortRecords(records []Record, filter Filter) {
	desc := filter.SortOrder != "asc"
	less := func(i, j int) bool {
		left, right := records[i], records[j]
		var result bool
		switch filter.SortBy {
		case "model":
			result = strings.ToLower(left.Model) < strings.ToLower(right.Model)
		case "provider":
			result = strings.ToLower(left.Provider) < strings.ToLower(right.Provider)
		case "tokens":
			result = left.Tokens.TotalTokens < right.Tokens.TotalTokens
		case "cost":
			result = left.Cost < right.Cost
		case "latency":
			result = left.LatencyMs < right.LatencyMs
		default:
			result = left.Timestamp.Before(right.Timestamp)
		}
		if desc {
			return !result && !recordsEqualForSort(left, right, filter.SortBy)
		}
		return result
	}
	sort.SliceStable(records, less)
}

func recordsEqualForSort(left, right Record, sortBy string) bool {
	switch sortBy {
	case "model":
		return strings.EqualFold(left.Model, right.Model)
	case "provider":
		return strings.EqualFold(left.Provider, right.Provider)
	case "tokens":
		return left.Tokens.TotalTokens == right.Tokens.TotalTokens
	case "cost":
		return left.Cost == right.Cost
	case "latency":
		return left.LatencyMs == right.LatencyMs
	default:
		return left.Timestamp.Equal(right.Timestamp)
	}
}

func withCost(record Record, pricing PricingConfig) Record {
	rule, ok := resolvePricingRule(pricing, record.Provider, record.Model, record.Tokens.InputTokens)
	if !ok {
		record.Cost = 0
		record.CostKnown = false
		return record
	}
	inputTokens := maxInt64(record.Tokens.InputTokens-record.Tokens.CachedTokens, 0)
	cachedTokens := maxInt64(record.Tokens.CachedTokens, 0)
	reasoningTokens := maxInt64(record.Tokens.ReasoningTokens, 0)
	outputTokens := maxInt64(record.Tokens.OutputTokens-reasoningTokens, 0)
	reasoningRate := rule.ReasoningPerMillion
	if reasoningRate == 0 {
		reasoningRate = rule.OutputPerMillion
	}
	record.Cost = (float64(inputTokens)*rule.InputPerMillion +
		float64(outputTokens)*rule.OutputPerMillion +
		float64(reasoningTokens)*reasoningRate +
		float64(cachedTokens)*rule.CachedPerMillion) / 1_000_000
	record.CostKnown = true
	return record
}

func resolvePricingRule(pricing PricingConfig, provider, model string, inputTokens int64) (PricingRule, bool) {
	candidates := []string{
		strings.TrimSpace(provider) + "/" + strings.TrimSpace(model),
		strings.TrimSpace(model),
	}
	for _, candidate := range candidates {
		if candidate == "" || candidate == "/" {
			continue
		}
		for key, rule := range pricing.Models {
			if rule.Enabled && strings.EqualFold(strings.TrimSpace(key), candidate) {
				return rule, true
			}
		}
	}
	if pricing.Default.Enabled {
		return pricing.Default, true
	}
	if rule, ok := builtinPricingRule(model); ok {
		if inputTokens > longContextInputTokenCutover && builtinLongContextPricing(model) {
			rule.InputPerMillion *= 2
			rule.CachedPerMillion *= 2
		}
		return rule, true
	}
	return PricingRule{}, false
}

var builtinPricingRates = map[string][3]float64{
	"codex-auto-review":   {1.5, 12, 0.15},
	"gpt-5-codex":         {1.5, 12, 0.15},
	"gpt-5.1-codex-max":   {1.5, 12, 0.15},
	"gpt-5.1-codex-mini":  {1.5, 12, 0.15},
	"gpt-5.2-codex":       {1.75, 14, 0.175},
	"gpt-5.3-codex-spark": {1.5, 12, 0.15},
	"gpt-5.4":             {2.5, 15, 0.25},
	"gpt-5.4-mini":        {0.75, 4.5, 0.075},
	"gpt-5.5":             {2.5, 15, 0.25},
	"gpt-5.6-luna":        {1, 6, 0.1},
	"gpt-5.6-sol":         {5, 30, 0.5},
	"gpt-5.6-terra":       {2.5, 15, 0.25},
}

func builtinPricingRule(model string) (PricingRule, bool) {
	model = strings.ToLower(strings.TrimSpace(model))
	rate, ok := builtinPricingRates[model]
	if !ok {
		return PricingRule{}, false
	}
	return PricingRule{
		Enabled:             true,
		InputPerMillion:     rate[0],
		OutputPerMillion:    rate[1],
		ReasoningPerMillion: rate[1],
		CachedPerMillion:    rate[2],
	}, true
}

func builtinLongContextPricing(model string) bool {
	switch strings.ToLower(strings.TrimSpace(model)) {
	case "gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra":
		return true
	default:
		return false
	}
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

func addBreakdown(target map[string]*Breakdown, key string, record Record) {
	key = strings.TrimSpace(key)
	if key == "" {
		key = "unknown"
	}
	item := target[key]
	if item == nil {
		item = &Breakdown{Key: key, CostKnown: true}
		target[key] = item
	}
	item.Requests++
	if record.Failed {
		item.Failures++
	}
	item.Tokens += record.Tokens.TotalTokens
	item.InputTokens += record.Tokens.InputTokens
	item.OutputTokens += record.Tokens.OutputTokens
	item.CachedTokens += record.Tokens.CachedTokens
	item.Cost += record.Cost
	item.CostKnown = item.CostKnown && record.CostKnown
}

func sortedBreakdowns(values map[string]*Breakdown) []Breakdown {
	result := make([]Breakdown, 0, len(values))
	for _, item := range values {
		result = append(result, *item)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Tokens == result[j].Tokens {
			if result[i].Requests == result[j].Requests {
				return strings.ToLower(result[i].Key) < strings.ToLower(result[j].Key)
			}
			return result[i].Requests > result[j].Requests
		}
		return result[i].Tokens > result[j].Tokens
	})
	return result
}

func trendBucket(timestamp time.Time, granularity string) time.Time {
	timestamp = timestamp.UTC()
	if granularity == "hour" {
		return timestamp.Truncate(time.Hour)
	}
	return time.Date(timestamp.Year(), timestamp.Month(), timestamp.Day(), 0, 0, 0, 0, time.UTC)
}

func sortedTrend(values map[time.Time]*TrendPoint) []TrendPoint {
	result := make([]TrendPoint, 0, len(values))
	for _, point := range values {
		result = append(result, *point)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Timestamp.Before(result[j].Timestamp)
	})
	return result
}

var defaultStore = NewStore()

func Configure(recordPath, pricingPath string) error {
	return defaultStore.Configure(recordPath, pricingPath)
}

func Append(record Record) error {
	return defaultStore.Append(record)
}

func Query(filter Filter) ListResult {
	return defaultStore.Query(filter)
}

func GetStats(filter Filter) Stats {
	return defaultStore.Stats(filter)
}

func GetPricing() PricingConfig {
	return defaultStore.Pricing()
}

func SetPricing(pricing PricingConfig) error {
	return defaultStore.SetPricing(pricing)
}
