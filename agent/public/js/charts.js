/* agent/public/js/charts.js
 * Chart.js initialization and dashboard interactivity
 */

// Chart instances
let deliveryChart = null;
let featureChart = null;
let trendChart = null;
let healthChart = null;

// Chart data storage
let chartData = null;
let insightsData = null;

// Pod colors matching backend
const POD_COLORS = {
  FTS: '#6366f1',
  GTS: '#8b5cf6',
  'Control Center': '#ec4899',
  'Talent Studio': '#14b8a6',
  Platform: '#f59e0b',
  'Growth and Reuse': '#22c55e',
};

// Default chart options for dark theme
const darkThemeDefaults = {
  color: 'rgba(255, 255, 255, 0.7)',
  borderColor: 'rgba(255, 255, 255, 0.1)',
};

// Set Chart.js defaults for dark theme
Chart.defaults.color = darkThemeDefaults.color;
Chart.defaults.borderColor = darkThemeDefaults.borderColor;

// ============== Data Fetching ==============

async function fetchChartData() {
  try {
    const response = await fetch('/api/charts/data');
    const data = await response.json();

    if (!data.success) {
      console.error('Chart data fetch failed:', data.error);
      showError('Failed to load chart data: ' + (data.message || data.error));
      return null;
    }

    return data;
  } catch (err) {
    console.error('Error fetching chart data:', err);
    showError('Failed to connect to server. Is it running?');
    return null;
  }
}

async function fetchInsights() {
  try {
    const response = await fetch('/api/charts/insights');
    const data = await response.json();
    return data;
  } catch (err) {
    console.error('Error fetching insights:', err);
    return { success: false, insights: [] };
  }
}

// ============== Hero Metrics ==============

function updateHeroMetrics(metrics) {
  if (!metrics) return;

  // Overall delivery
  document.getElementById('heroDelivery').textContent = `${metrics.overallDeliveryPct}%`;
  document.getElementById('heroDeliveryDetail').textContent =
    `${metrics.totalCompleted}/${metrics.totalCommitted} DELs in ${metrics.currentCycle}`;

  // Features done
  document.getElementById('heroFeatures').textContent = metrics.featuresDone;
  document.getElementById('heroFeaturesDetail').textContent =
    `${metrics.featuresInFlight} in flight, ${metrics.totalFeatures} total`;

  // Active pods
  document.getElementById('heroActivePods').textContent = metrics.activePods;
  document.getElementById('heroPodsDetail').textContent =
    `of ${metrics.totalPods} pods with commitments`;

  // Top performer
  if (metrics.topPerformer) {
    document.getElementById('heroTopPerformer').textContent = metrics.topPerformer.pod;
    document.getElementById('heroTopDetail').textContent =
      `${metrics.topPerformer.deliveryPct} delivery rate`;
  } else {
    document.getElementById('heroTopPerformer').textContent = '--';
    document.getElementById('heroTopDetail').textContent = 'No data';
  }

  // Update timestamp
  document.getElementById('lastUpdated').textContent =
    new Date(chartData.fetchedAt).toLocaleString();
}

// ============== Chart Creation ==============

function createDeliveryChart(data) {
  const ctx = document.getElementById('deliveryChart').getContext('2d');
  const chartConfig = data.deliveryChart;

  // Update badge
  document.getElementById('deliveryCycleBadge').textContent = chartConfig.meta.cycle;

  // Create gradient fills
  const gradients = chartConfig.data.labels.map((label, i) => {
    const gradient = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
    const color = chartConfig.data.datasets[0].backgroundColor[i];
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, `${color}80`);
    return gradient;
  });

  deliveryChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: chartConfig.data.labels,
      datasets: [{
        ...chartConfig.data.datasets[0],
        backgroundColor: gradients,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 1000,
        easing: 'easeOutQuart',
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 15, 26, 0.95)',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 12,
          titleColor: '#fff',
          bodyColor: 'rgba(255, 255, 255, 0.8)',
          callbacks: {
            label: (ctx) => {
              const i = ctx.dataIndex;
              const committed = chartConfig.meta.committed[i];
              const completed = chartConfig.meta.completed[i];
              return [
                `Delivery: ${ctx.raw}%`,
                `Committed: ${committed}`,
                `Completed: ${completed}`,
              ];
            },
          },
        },
      },
      scales: {
        x: {
          max: 100,
          grid: {
            color: 'rgba(255, 255, 255, 0.05)',
          },
          ticks: {
            callback: (val) => `${val}%`,
          },
        },
        y: {
          grid: { display: false },
        },
      },
      onClick: (e, elements) => {
        if (elements.length > 0) {
          const index = elements[0].index;
          const podName = chartConfig.data.labels[index];
          showPodDetail(podName);
        }
      },
    },
  });

  hideLoading('deliveryLoading');
}

function createFeatureChart(data) {
  const ctx = document.getElementById('featureChart').getContext('2d');
  const chartConfig = data.featureChart;

  // Update badge
  document.getElementById('featureTotalBadge').textContent =
    `${chartConfig.meta.totalFeatures} features`;

  // Update donut center
  document.getElementById('donutCenter').querySelector('.donut-value').textContent =
    `${chartConfig.meta.donePercentage}%`;

  featureChart = new Chart(ctx, {
    type: 'doughnut',
    data: chartConfig.data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      animation: {
        animateRotate: true,
        duration: 1200,
        easing: 'easeOutQuart',
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 20,
          },
        },
        tooltip: {
          backgroundColor: 'rgba(15, 15, 26, 0.95)',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total > 0 ? Math.round((ctx.raw / total) * 100) : 0;
              return `${ctx.label}: ${ctx.raw} (${pct}%)`;
            },
          },
        },
      },
    },
  });

  hideLoading('featureLoading');
}

function createTrendChart(data) {
  const ctx = document.getElementById('trendChart').getContext('2d');
  const chartConfig = data.cycleTrendChart;

  // Build legend
  buildTrendLegend(chartConfig.data.datasets);

  trendChart = new Chart(ctx, {
    type: 'line',
    data: chartConfig.data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 1500,
        easing: 'easeOutQuart',
      },
      interaction: {
        intersect: false,
        mode: 'index',
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 15, 26, 0.95)',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (ctx) => {
              if (ctx.raw === null) return null;
              return `${ctx.dataset.label}: ${ctx.raw}%`;
            },
          },
        },
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          grid: {
            color: 'rgba(255, 255, 255, 0.05)',
          },
          ticks: {
            callback: (val) => `${val}%`,
          },
        },
        x: {
          grid: {
            color: 'rgba(255, 255, 255, 0.05)',
          },
        },
      },
    },
  });

  hideLoading('trendLoading');
}

function createHealthChart(data) {
  const ctx = document.getElementById('healthChart').getContext('2d');
  const chartConfig = data.podHealthChart;

  healthChart = new Chart(ctx, {
    type: 'radar',
    data: chartConfig.data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 1200,
        easing: 'easeOutQuart',
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 15,
            font: { size: 11 },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(15, 15, 26, 0.95)',
          borderColor: 'rgba(255, 255, 255, 0.1)',
          borderWidth: 1,
          padding: 12,
        },
      },
      scales: {
        r: {
          min: 0,
          max: 100,
          beginAtZero: true,
          grid: {
            color: 'rgba(255, 255, 255, 0.1)',
          },
          angleLines: {
            color: 'rgba(255, 255, 255, 0.1)',
          },
          pointLabels: {
            color: 'rgba(255, 255, 255, 0.7)',
            font: { size: 11 },
          },
          ticks: {
            display: false,
            stepSize: 25,
          },
        },
      },
    },
  });

  hideLoading('healthLoading');
}

function buildTrendLegend(datasets) {
  const legendEl = document.getElementById('trendLegend');
  legendEl.innerHTML = datasets.map(ds => `
    <div class="chart-legend-item">
      <span class="chart-legend-color" style="background: ${ds.borderColor}"></span>
      <span>${ds.label}</span>
    </div>
  `).join('');
}

// ============== Insights Panel ==============

function renderInsights(data) {
  const grid = document.getElementById('insightsGrid');

  if (!data || !data.success || !data.insights || data.insights.length === 0) {
    grid.innerHTML = `
      <div class="insight-card trend" style="grid-column: span 3; text-align: center; opacity: 1;">
        <div class="insight-text">No insights available. Try refreshing the data.</div>
      </div>
    `;
    return;
  }

  grid.innerHTML = data.insights.map((insight, i) => `
    <div class="insight-card ${insight.type}" data-chart="${insight.relatedChart || ''}" data-pod="${insight.relatedPod || ''}">
      <div class="insight-header">
        ${getInsightIcon(insight.type)}
        <span class="insight-type">${getInsightLabel(insight.type)}</span>
      </div>
      <div class="insight-title">${escapeHtml(insight.title)}</div>
      <div class="insight-text">${escapeHtml(insight.text)}</div>
    </div>
  `).join('');

  // Add hover interactions
  document.querySelectorAll('.insight-card[data-chart]').forEach(card => {
    card.addEventListener('mouseenter', () => highlightRelatedChart(card.dataset.chart));
    card.addEventListener('mouseleave', () => removeChartHighlight());
  });
}

function getInsightIcon(type) {
  const icons = {
    highlight: '<svg class="insight-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
    warning: '<svg class="insight-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    trend: '<svg class="insight-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    action: '<svg class="insight-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  };
  return icons[type] || icons.trend;
}

function getInsightLabel(type) {
  const labels = {
    highlight: 'Highlight',
    warning: 'Attention',
    trend: 'Trend',
    action: 'Action',
  };
  return labels[type] || 'Insight';
}

function highlightRelatedChart(chartId) {
  const cardMap = {
    delivery: 'deliveryCard',
    feature: 'featureCard',
    trend: 'trendCard',
    health: 'healthCard',
  };

  const cardEl = document.getElementById(cardMap[chartId]);
  if (cardEl) {
    cardEl.style.boxShadow = '0 0 30px rgba(99, 102, 241, 0.3)';
    cardEl.style.borderColor = 'rgba(99, 102, 241, 0.5)';
  }
}

function removeChartHighlight() {
  ['deliveryCard', 'featureCard', 'trendCard', 'healthCard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.style.boxShadow = '';
      el.style.borderColor = '';
    }
  });
}

// ============== Utility Functions ==============

function hideLoading(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function showError(message) {
  console.error(message);
  // Could add a toast notification here
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showPodDetail(podName) {
  // Could open a modal or navigate to detail view
  console.log('Pod clicked:', podName);
  // For now, just scroll to health chart which shows all pods
  document.getElementById('healthCard').scrollIntoView({ behavior: 'smooth' });
}

// ============== Initialization ==============

async function initDashboard() {
  // Fetch chart data
  chartData = await fetchChartData();

  if (chartData) {
    // Update hero metrics
    updateHeroMetrics(chartData.heroMetrics);

    // Create all charts
    createDeliveryChart(chartData);
    createFeatureChart(chartData);
    createTrendChart(chartData);
    createHealthChart(chartData);
  }

  // Fetch and render insights (can run in parallel)
  insightsData = await fetchInsights();
  renderInsights(insightsData);
}

// Event listeners
document.addEventListener('DOMContentLoaded', initDashboard);

// Refresh insights button
document.getElementById('refreshInsights')?.addEventListener('click', async () => {
  const btn = document.getElementById('refreshInsights');
  btn.disabled = true;

  // Show loading state
  const grid = document.getElementById('insightsGrid');
  grid.innerHTML = `
    <div class="insight-card loading">
      <div class="insight-skeleton"></div>
      <div class="insight-skeleton short"></div>
    </div>
    <div class="insight-card loading">
      <div class="insight-skeleton"></div>
      <div class="insight-skeleton short"></div>
    </div>
    <div class="insight-card loading">
      <div class="insight-skeleton"></div>
      <div class="insight-skeleton short"></div>
    </div>
  `;

  // Fetch fresh insights
  insightsData = await fetchInsights();
  renderInsights(insightsData);

  btn.disabled = false;
});

// Health chart toggle (cycle through pods)
let healthPodIndex = -1; // -1 means show all
document.getElementById('healthToggle')?.addEventListener('click', () => {
  if (!chartData || !chartData.podHealthChart) return;

  const datasets = chartData.podHealthChart.data.datasets;
  healthPodIndex = (healthPodIndex + 1) % (datasets.length + 1);

  if (healthPodIndex === datasets.length) {
    // Show all
    healthPodIndex = -1;
    healthChart.data.datasets = datasets;
  } else {
    // Show single pod
    healthChart.data.datasets = [datasets[healthPodIndex]];
  }

  healthChart.update();
});

// Responsive chart resize
window.addEventListener('resize', () => {
  [deliveryChart, featureChart, trendChart, healthChart].forEach(chart => {
    if (chart) chart.resize();
  });
});
