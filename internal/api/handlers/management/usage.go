package management

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/redisqueue"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/usagehistory"
)

type usageQueueRecord []byte

func (r usageQueueRecord) MarshalJSON() ([]byte, error) {
	if json.Valid(r) {
		return append([]byte(nil), r...), nil
	}
	return json.Marshal(string(r))
}

// GetUsageQueue pops queued usage records from the usage queue.
func (h *Handler) GetUsageQueue(c *gin.Context) {
	if h == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "handler unavailable"})
		return
	}

	count, errCount := parseUsageQueueCount(c.Query("count"))
	if errCount != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": errCount.Error()})
		return
	}

	items := redisqueue.PopOldest(count)
	records := make([]usageQueueRecord, 0, len(items))
	for _, item := range items {
		records = append(records, usageQueueRecord(append([]byte(nil), item...)))
	}

	c.JSON(http.StatusOK, records)
}

func parseUsageQueueCount(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 1, nil
	}
	count, errCount := strconv.Atoi(value)
	if errCount != nil || count <= 0 {
		return 0, errors.New("count must be a positive integer")
	}
	return count, nil
}

// GetUsageRecords returns durable usage records without consuming the short-lived queue.
func (h *Handler) GetUsageRecords(c *gin.Context) {
	filter, err := parseUsageHistoryFilter(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, usagehistory.Query(filter))
}

// GetUsageRecordStats returns aggregate usage, distributions and time trend data.
func (h *Handler) GetUsageRecordStats(c *gin.Context) {
	filter, err := parseUsageHistoryFilter(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, usagehistory.GetStats(filter))
}

func (h *Handler) GetUsagePricing(c *gin.Context) {
	c.JSON(http.StatusOK, usagehistory.GetPricing())
}

func (h *Handler) PutUsagePricing(c *gin.Context) {
	var pricing usagehistory.PricingConfig
	if err := c.ShouldBindJSON(&pricing); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid pricing payload"})
		return
	}
	if err := usagehistory.SetPricing(pricing); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, usagehistory.GetPricing())
}

func parseUsageHistoryFilter(c *gin.Context) (usagehistory.Filter, error) {
	page, err := parsePositiveQueryInt(c.Query("page"), 1)
	if err != nil {
		return usagehistory.Filter{}, errors.New("page must be a positive integer")
	}
	pageSize, err := parsePositiveQueryInt(c.Query("page_size"), 50)
	if err != nil {
		return usagehistory.Filter{}, errors.New("page_size must be a positive integer")
	}
	if pageSize > 200 {
		pageSize = 200
	}

	startRaw := firstNonEmpty(c.Query("start"), c.Query("start_date"))
	endRaw := firstNonEmpty(c.Query("end"), c.Query("end_date"))
	start, err := parseUsageHistoryTime(startRaw, false)
	if err != nil {
		return usagehistory.Filter{}, errors.New("invalid start time")
	}
	end, err := parseUsageHistoryTime(endRaw, true)
	if err != nil {
		return usagehistory.Filter{}, errors.New("invalid end time")
	}

	status := strings.ToLower(strings.TrimSpace(c.Query("status")))
	if status != "" && status != "all" && status != "success" && status != "failed" {
		return usagehistory.Filter{}, errors.New("status must be all, success or failed")
	}
	granularity := strings.ToLower(strings.TrimSpace(c.Query("granularity")))
	if granularity != "" && granularity != "day" && granularity != "hour" {
		return usagehistory.Filter{}, errors.New("granularity must be day or hour")
	}

	return usagehistory.Filter{
		Start:       start,
		End:         end,
		Model:       strings.TrimSpace(c.Query("model")),
		Provider:    strings.TrimSpace(c.Query("provider")),
		Endpoint:    strings.TrimSpace(c.Query("endpoint")),
		Source:      strings.TrimSpace(c.Query("source")),
		AuthIndex:   strings.TrimSpace(c.Query("auth_index")),
		Status:      status,
		Search:      strings.TrimSpace(c.Query("search")),
		SortBy:      strings.TrimSpace(c.DefaultQuery("sort_by", "timestamp")),
		SortOrder:   strings.TrimSpace(c.DefaultQuery("sort_order", "desc")),
		Granularity: granularity,
		Page:        page,
		PageSize:    pageSize,
	}, nil
}

func parsePositiveQueryInt(value string, fallback int) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, errors.New("must be a positive integer")
	}
	return parsed, nil
}

func parseUsageHistoryTime(value string, endOfDate bool) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, nil
	}
	if parsed, err := time.Parse("2006-01-02", value); err == nil {
		if endOfDate {
			return parsed.AddDate(0, 0, 1), nil
		}
		return parsed, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339Nano, value)
	}
	return parsed, err
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
