/**
 * Health & Status API
 * GET /api/health - Check system capacity and health
 * POST /api/health?action=reset - Force reset the queue (emergency recovery)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSystemHealth, recognitionQueue } from '@/lib/request-queue';

export async function GET() {
  try {
    const health = getSystemHealth();
    const queueStats = recognitionQueue.getStats();
    
    return NextResponse.json({
      status: health.healthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      
      // Capacity info for clients
      capacity: {
        canAcceptRequests: recognitionQueue.canAcceptRequest(),
        queueLength: queueStats.currentQueueLength,
        activeRequests: queueStats.activeRequests,
        maxConcurrent: queueStats.maxConcurrent,
        estimatedWaitSeconds: queueStats.estimatedWaitForNew,
        requestsLastMinute: queueStats.requestsLastMinute,
      },
      
      // Performance metrics
      performance: {
        avgProcessingTimeMs: queueStats.avgProcessingTimeMs,
        avgProcessingTimeFormatted: `${Math.round(queueStats.avgProcessingTimeMs / 1000)}s`,
      },
      
      // Rate limit status
      rateLimits: health.rateLimits,
      
      // Recommendations if any issues
      recommendations: health.recommendations,
      
      // Viral capacity estimates
      viralCapacity: {
        freeTeir: '~0.5 requests/minute (Gemini bottleneck)',
        paidGemini: '~30-40 requests/minute',
        fullPaidStack: '~50-100 requests/minute',
        note: 'Upgrade to paid Gemini API for viral traffic',
      },
    });
  } catch (error) {
    console.error('Health check error:', error);
    return NextResponse.json(
      { status: 'error', message: 'Health check failed' },
      { status: 500 }
    );
  }
}

// POST /api/health?action=reset - Force reset queue (requires secret)
export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get('action');
    const secret = searchParams.get('secret');
    
    // Simple secret protection
    const expectedSecret = process.env.CRON_SECRET || 'reset-queue-secret';
    if (secret !== expectedSecret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    
    if (action === 'reset') {
      recognitionQueue.forceReset();
      return NextResponse.json({
        success: true,
        message: 'Queue force reset complete',
        timestamp: new Date().toISOString(),
      });
    }
    
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (error) {
    console.error('Health POST error:', error);
    return NextResponse.json(
      { error: 'Failed to process request' },
      { status: 500 }
    );
  }
}