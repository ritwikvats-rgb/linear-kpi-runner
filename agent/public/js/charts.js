/* agent/public/js/charts.js
 * Chart.js initialization and dashboard interactivity
 * Enhanced with 3D effects, animations, and particle system
 */

// Chart instances
let deliveryChart = null;
let featureChart = null;
let trendChart = null;
let healthChart = null;

// Chart data storage
let chartData = null;
let insightsData = null;

// Particle system
let particleCanvas = null;
let particleCtx = null;
let particles = [];
let animationFrame = null;

// Pod colors matching backend (enhanced with gradients)
const POD_COLORS = {
  FTS: '#6366f1',
  GTS: '#8b5cf6',
  'Control Center': '#ec4899',
  'Talent Studio': '#14b8a6',
  Platform: '#f59e0b',
  'Growth and Reuse': '#22c55e',
};

const POD_GRADIENTS = {
  FTS: ['#6366f1', '#818cf8'],
  GTS: ['#8b5cf6', '#a78bfa'],
  'Control Center': ['#ec4899', '#f472b6'],
  'Talent Studio': ['#14b8a6', '#2dd4bf'],
  Platform: ['#f59e0b', '#fbbf24'],
  'Growth and Reuse': ['#22c55e', '#4ade80'],
};

// Default chart options for dark theme
const darkThemeDefaults = {
  color: 'rgba(255, 255, 255, 0.7)',
  borderColor: 'rgba(255, 255, 255, 0.1)',
};

// Set Chart.js defaults for dark theme
Chart.defaults.color = darkThemeDefaults.color;
Chart.defaults.borderColor = darkThemeDefaults.borderColor;

// ============== Particle System ==============

class Particle {
  constructor(canvas) {
    this.canvas = canvas;
    this.reset();
  }

  reset() {
    this.x = Math.random() * this.canvas.width;
    this.y = Math.random() * this.canvas.height;
    this.size = Math.random() * 2 + 0.5;
    this.speedX = (Math.random() - 0.5) * 0.5;
    this.speedY = (Math.random() - 0.5) * 0.5;
    this.opacity = Math.random() * 0.5 + 0.1;
    this.color = `rgba(99, 102, 241, ${this.opacity})`;
  }

  update() {
    this.x += this.speedX;
    this.y += this.speedY;

    // Wrap around screen
    if (this.x < 0) this.x = this.canvas.width;
    if (this.x > this.canvas.width) this.x = 0;
    if (this.y < 0) this.y = this.canvas.height;
    if (this.y > this.canvas.height) this.y = 0;
  }

  draw(ctx) {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.fill();
  }
}

function initParticles() {
  particleCanvas = document.getElementById('particleCanvas');
  if (!particleCanvas) return;

  particleCtx = particleCanvas.getContext('2d');
  resizeParticleCanvas();

  // Create particles
  const particleCount = Math.min(50, Math.floor((particleCanvas.width * particleCanvas.height) / 20000));
  for (let i = 0; i < particleCount; i++) {
    particles.push(new Particle(particleCanvas));
  }

  animateParticles();
}

function resizeParticleCanvas() {
  if (!particleCanvas) return;
  particleCanvas.width = window.innerWidth;
  particleCanvas.height = window.innerHeight;
}

function animateParticles() {
  if (!particleCtx) return;

  particleCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);

  // Draw connections between nearby particles
  particles.forEach((p1, i) => {
    particles.slice(i + 1).forEach(p2 => {
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < 120) {
        particleCtx.beginPath();
        particleCtx.strokeStyle = `rgba(99, 102, 241, ${0.1 * (1 - distance / 120)})`;
        particleCtx.lineWidth = 0.5;
        particleCtx.moveTo(p1.x, p1.y);
        particleCtx.lineTo(p2.x, p2.y);
        particleCtx.stroke();
      }
    });
  });

  // Update and draw particles
  particles.forEach(p => {
    p.update();
    p.draw(particleCtx);
  });

  animationFrame = requestAnimationFrame(animateParticles);
}

// ============== Animated Counter ==============

function animateCounter(element, target, suffix = '', duration = 1500) {
  const start = 0;
  const startTime = performance.now();

  function update(currentTime) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);

    // Easing function (ease out cubic)
    const easeOut = 1 - Math.pow(1 - progress, 3);
    const current = Math.floor(start + (target - start) * easeOut);

    element.textContent = current + suffix;

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      element.textContent = target + suffix;
    }
  }

  requestAnimationFrame(update);
}

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

  // Overall delivery with animated counter
  const deliveryEl = document.getElementById('heroDelivery');
  animateCounter(deliveryEl, metrics.overallDeliveryPct, '%', 1500);
  document.getElementById('heroDeliveryDetail').textContent =
    `${metrics.totalCompleted}/${metrics.totalCommitted} DELs in ${metrics.currentCycle}`;

  // Features done with animated counter
  const featuresEl = document.getElementById('heroFeatures');
  animateCounter(featuresEl, metrics.featuresDone, '', 1200);
  document.getElementById('heroFeaturesDetail').textContent =
    `${metrics.featuresInFlight} in flight, ${metrics.totalFeatures} total`;

  // Active pods with animated counter
  const podsEl = document.getElementById('heroActivePods');
  animateCounter(podsEl, metrics.activePods, '', 1000);
  document.getElementById('heroPodsDetail').textContent =
    `of ${metrics.totalPods} pods with commitments`;

  // Top performer (no counter, just text)
  if (metrics.topPerformer) {
    const topEl = document.getElementById('heroTopPerformer');
    topEl.textContent = metrics.topPerformer.pod;
    topEl.classList.add('highlight-text');
    document.getElementById('heroTopDetail').textContent =
      `${metrics.topPerformer.deliveryPct} delivery rate`;
  } else {
    document.getElementById('heroTopPerformer').textContent = '--';
    document.getElementById('heroTopDetail').textContent = 'No data';
  }

  // Update timestamp
  document.getElementById('lastUpdated').textContent =
    new Date(chartData.fetchedAt).toLocaleString();

  // Trigger hero card animations
  document.querySelectorAll('.hero-card').forEach((card, i) => {
    card.style.opacity = '0';
    card.style.transform = 'translateY(20px)';
    setTimeout(() => {
      card.style.transition = 'all 0.5s ease';
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    }, i * 100);
  });
}

// ============== Chart Creation ==============

function createDeliveryChart(data) {
  const ctx = document.getElementById('deliveryChart').getContext('2d');
  const chartConfig = data.deliveryChart;

  // Update badge with animation
  const badge = document.getElementById('deliveryCycleBadge');
  badge.textContent = chartConfig.meta.cycle;
  badge.classList.add('pulse');

  // Create enhanced gradient fills with glow effect
  const gradients = chartConfig.data.labels.map((label, i) => {
    const gradient = ctx.createLinearGradient(0, 0, ctx.canvas.width, 0);
    const baseColor = chartConfig.data.datasets[0].backgroundColor[i];
    const podGradient = POD_GRADIENTS[label] || [baseColor, baseColor];
    gradient.addColorStop(0, podGradient[0]);
    gradient.addColorStop(0.5, podGradient[1]);
    gradient.addColorStop(1, `${podGradient[0]}60`);
    return gradient;
  });

  // Create shadow/glow effect
  const shadowColors = chartConfig.data.labels.map((label) => {
    const color = POD_COLORS[label] || '#6366f1';
    return `${color}40`;
  });

  deliveryChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: chartConfig.data.labels,
      datasets: [{
        ...chartConfig.data.datasets[0],
        backgroundColor: gradients,
        borderColor: chartConfig.data.labels.map(label => POD_COLORS[label] || '#6366f1'),
        borderWidth: 1,
        borderRadius: 8,
        borderSkipped: false,
      }],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 1500,
        easing: 'easeOutQuart',
        delay: (context) => context.dataIndex * 100,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(15, 15, 26, 0.95)',
          borderColor: 'rgba(99, 102, 241, 0.3)',
          borderWidth: 1,
          padding: 16,
          titleColor: '#fff',
          titleFont: { size: 14, weight: 'bold' },
          bodyColor: 'rgba(255, 255, 255, 0.8)',
          bodyFont: { size: 13 },
          cornerRadius: 12,
          displayColors: false,
          callbacks: {
            title: (items) => items[0].label,
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
            color: 'rgba(255, 255, 255, 0.03)',
            drawBorder: false,
          },
          ticks: {
            callback: (val) => `${val}%`,
            font: { size: 11 },
          },
        },
        y: {
          grid: { display: false },
          ticks: {
            font: { size: 12, weight: '500' },
          },
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

  // Update donut center with animation
  const donutValue = document.getElementById('donutCenter').querySelector('.donut-value');
  animateCounter(donutValue, chartConfig.meta.donePercentage, '%', 1500);

  // Enhanced colors with gradients
  const enhancedColors = [
    '#22c55e', // Done - green
    '#6366f1', // In Flight - indigo
    '#64748b', // Not Started - slate
  ];

  featureChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      ...chartConfig.data,
      datasets: [{
        ...chartConfig.data.datasets[0],
        backgroundColor: enhancedColors,
        borderColor: '#0f0f1a',
        borderWidth: 3,
        hoverBorderColor: '#fff',
        hoverBorderWidth: 2,
        hoverOffset: 8,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '72%',
      animation: {
        animateRotate: true,
        animateScale: true,
        duration: 1800,
        easing: 'easeOutQuart',
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 20,
            font: { size: 12, weight: '500' },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(15, 15, 26, 0.95)',
          borderColor: 'rgba(99, 102, 241, 0.3)',
          borderWidth: 1,
          padding: 16,
          cornerRadius: 12,
          titleFont: { size: 14, weight: 'bold' },
          bodyFont: { size: 13 },
          displayColors: true,
          boxPadding: 6,
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
              const pct = total > 0 ? Math.round((ctx.raw / total) * 100) : 0;
              return ` ${ctx.label}: ${ctx.raw} (${pct}%)`;
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

  // Enhance datasets with gradient fills
  const enhancedDatasets = chartConfig.data.datasets.map((ds, i) => {
    const gradient = ctx.createLinearGradient(0, 0, 0, ctx.canvas.height);
    const color = ds.borderColor || POD_COLORS[ds.label] || '#6366f1';
    gradient.addColorStop(0, `${color}40`);
    gradient.addColorStop(1, `${color}00`);

    return {
      ...ds,
      fill: true,
      backgroundColor: gradient,
      borderWidth: 3,
      pointRadius: 4,
      pointHoverRadius: 8,
      pointBackgroundColor: color,
      pointBorderColor: '#0f0f1a',
      pointBorderWidth: 2,
      pointHoverBackgroundColor: '#fff',
      pointHoverBorderColor: color,
      pointHoverBorderWidth: 3,
      tension: 0.4,
    };
  });

  trendChart = new Chart(ctx, {
    type: 'line',
    data: {
      ...chartConfig.data,
      datasets: enhancedDatasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 2000,
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
          borderColor: 'rgba(99, 102, 241, 0.3)',
          borderWidth: 1,
          padding: 16,
          cornerRadius: 12,
          titleFont: { size: 14, weight: 'bold' },
          bodyFont: { size: 12 },
          callbacks: {
            label: (ctx) => {
              if (ctx.raw === null) return null;
              return ` ${ctx.dataset.label}: ${ctx.raw}%`;
            },
          },
        },
      },
      scales: {
        y: {
          min: 0,
          max: 100,
          grid: {
            color: 'rgba(255, 255, 255, 0.03)',
            drawBorder: false,
          },
          ticks: {
            callback: (val) => `${val}%`,
            font: { size: 11 },
          },
        },
        x: {
          grid: {
            color: 'rgba(255, 255, 255, 0.03)',
            drawBorder: false,
          },
          ticks: {
            font: { size: 11, weight: '500' },
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

  // Enhance datasets with gradient fills
  const enhancedDatasets = chartConfig.data.datasets.map((ds, i) => {
    const color = ds.borderColor || POD_COLORS[ds.label] || '#6366f1';
    return {
      ...ds,
      backgroundColor: `${color}30`,
      borderColor: color,
      borderWidth: 2,
      pointBackgroundColor: color,
      pointBorderColor: '#0f0f1a',
      pointBorderWidth: 2,
      pointRadius: 4,
      pointHoverRadius: 8,
      pointHoverBackgroundColor: '#fff',
      pointHoverBorderColor: color,
    };
  });

  healthChart = new Chart(ctx, {
    type: 'radar',
    data: {
      ...chartConfig.data,
      datasets: enhancedDatasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 1800,
        easing: 'easeOutQuart',
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            usePointStyle: true,
            pointStyle: 'circle',
            padding: 15,
            font: { size: 11, weight: '500' },
          },
        },
        tooltip: {
          backgroundColor: 'rgba(15, 15, 26, 0.95)',
          borderColor: 'rgba(99, 102, 241, 0.3)',
          borderWidth: 1,
          padding: 16,
          cornerRadius: 12,
          titleFont: { size: 14, weight: 'bold' },
          bodyFont: { size: 12 },
        },
      },
      scales: {
        r: {
          min: 0,
          max: 100,
          beginAtZero: true,
          grid: {
            color: 'rgba(99, 102, 241, 0.1)',
            circular: true,
          },
          angleLines: {
            color: 'rgba(99, 102, 241, 0.1)',
          },
          pointLabels: {
            color: 'rgba(255, 255, 255, 0.8)',
            font: { size: 11, weight: '500' },
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
    <div class="insight-card ${insight.type}" data-chart="${insight.relatedChart || ''}" data-pod="${insight.relatedPod || ''}" style="animation-delay: ${i * 0.1}s;">
      <div class="insight-header">
        ${getInsightIcon(insight.type)}
        <span class="insight-type">${getInsightLabel(insight.type)}</span>
      </div>
      <div class="insight-title">${escapeHtml(insight.title)}</div>
      <div class="insight-text">${escapeHtml(insight.text)}</div>
      <div class="insight-glow"></div>
    </div>
  `).join('');

  // Add hover interactions with enhanced effects
  document.querySelectorAll('.insight-card[data-chart]').forEach(card => {
    card.addEventListener('mouseenter', () => {
      highlightRelatedChart(card.dataset.chart);
      card.classList.add('hovered');
    });
    card.addEventListener('mouseleave', () => {
      removeChartHighlight();
      card.classList.remove('hovered');
    });
  });

  // Trigger entrance animations
  setTimeout(() => {
    document.querySelectorAll('.insight-card').forEach((card, i) => {
      setTimeout(() => card.classList.add('visible'), i * 100);
    });
  }, 100);
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
  // Initialize particle system
  initParticles();

  // Add resize listener for particles
  window.addEventListener('resize', resizeParticleCanvas);

  // Fetch chart data
  chartData = await fetchChartData();

  if (chartData) {
    // Update hero metrics with animated counters
    updateHeroMetrics(chartData.heroMetrics);

    // Create all charts with staggered animations
    setTimeout(() => createDeliveryChart(chartData), 100);
    setTimeout(() => createFeatureChart(chartData), 200);
    setTimeout(() => createTrendChart(chartData), 300);
    setTimeout(() => createHealthChart(chartData), 400);
  }

  // Fetch and render insights (can run in parallel)
  insightsData = await fetchInsights();
  renderInsights(insightsData);

  // Add intersection observer for scroll animations
  initScrollAnimations();
}

function initScrollAnimations() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -50px 0px'
  });

  document.querySelectorAll('.animate-in').forEach(el => {
    observer.observe(el);
  });
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
