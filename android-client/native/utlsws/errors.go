package utlsws

import "errors"

var (
	errClosed    = errors.New("connection closed")
	errQueueFull = errors.New("writer queue full")
)

const (
	maxTunnelMessageBytes = 65537
	defaultQueueMessages  = 256
	defaultQueueBytes     = 4 * 1024 * 1024
)
