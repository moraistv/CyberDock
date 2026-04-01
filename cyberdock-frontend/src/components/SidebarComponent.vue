<template>
  <div class="sidebar">
    <div>
      <div class="sidebar-header">
        <img src="@/assets/logo.png" alt="Logo" class="sidebar-logo" />
      </div>

      <nav class="sidebar-nav">
        <div class="sliding-indicator" :style="slidingIndicatorStyle"></div>
        <router-link
          v-for="(item, index) in navItems"
          :key="item.to"
          :to="item.to"
          class="nav-link"
          :ref="el => { if (el) navLinksRef[index] = el.$el }"
          @click="handleNavLinkClick"
        >
          <span class="nav-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <g class="icon-outline" v-html="item.iconOutline"></g>
              <g class="icon-solid" v-html="item.iconSolid"></g>
            </svg>
          </span>
          <span>{{ item.text }}</span>
        </router-link>
      </nav>
    </div>

    <!-- Container que renderiza condicionalmente a seção de admin ou de contas -->
    <div class="sidebar-bottom-section">
      <!-- Seção de Métricas do Administrador (visível apenas no modo admin) -->
      <div v-if="isAdminMode" class="admin-metrics-wrapper">
        <div class="admin-metrics-header">
          <h3 class="admin-metrics-title">Métricas do Sistema</h3>
        </div>
        <div class="admin-metrics-section">
          <div v-if="isLoadingMetrics" class="metrics-grid">
            <div v-for="i in 4" :key="i" class="metric-item-skeleton">
              <div class="skeleton-value"></div>
              <div class="skeleton-label"></div>
            </div>
          </div>
          <div v-else class="metrics-grid">
            <div class="metric-item">
              <span class="metric-value">{{ metrics.onlineUsers }}</span>
              <span class="metric-label">Usuários Online</span>
            </div>
            <div class="metric-item">
              <span class="metric-value">{{ metrics.newSignups }}</span>
              <span class="metric-label">Novos (Mês)</span>
            </div>
            <div class="metric-item">
              <span class="metric-value">{{ metrics.connectedAccounts }}</span>
              <span class="metric-label">Contas Ativas</span>
            </div>
            <div class="metric-item">
              <span class="metric-value" :class="{ 'has-errors': metrics.apiErrors > 0 }">{{ metrics.apiErrors }}</span>
              <span class="metric-label">Erros de API</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Seção de Contas (mostrada quando NÃO está em modo admin) -->
      <div v-else class="account-status-wrapper">
        <div class="account-status-header" @click="isAccountsSectionCollapsed = !isAccountsSectionCollapsed">
          <h3 class="account-status-title">Contas Mercado Livre</h3>
          <svg class="collapse-icon" :class="{ 'is-collapsed': isAccountsSectionCollapsed }" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </div>
        <div class="account-status-section" :class="{ 'is-collapsed': isAccountsSectionCollapsed }">
          <div v-if="isLoadingAccounts" class="status-list-skeleton">
            <div v-for="i in 3" :key="i" class="skeleton-item"><div class="skeleton-dot"></div><div class="skeleton-text"></div></div>
          </div>
          <div v-else-if="accountsError" class="status-list-message error">
            <p>Erro ao buscar contas.</p>
            <button @click="handleRetry" class="retry-button">Tentar Novamente</button>
          </div>
          <ul v-else-if="connectedAccounts.length > 0" class="account-status-list">
            <li v-for="account in connectedAccounts" :key="account.user_id" class="account-status-item" @mouseenter="showTooltip($event, account)" @mouseleave="hideTooltip" @contextmenu.prevent="showContextMenu($event, account)">
              <span class="status-dot" :class="account.status"></span>
              <span class="account-nickname">{{ account.nickname }}</span>
            </li>
          </ul>
          <div v-else class="status-list-message">
            <p>Nenhuma conta conectada.</p>
          </div>
          <router-link to="/contas" class="add-account-button">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              <span>Adicionar Conta</span>
          </router-link>
        </div>
      </div>
    </div>
    
    <div v-if="contextMenu.visible" class="context-menu" :style="{ top: contextMenu.top, left: contextMenu.left }">
        <div class="context-menu-header">{{ contextMenu.account.nickname }}</div>
        <button class="context-menu-item">Sincronizar Agora</button>
        <button class="context-menu-item">Ver Detalhes</button>
        <button class="context-menu-item danger">Desconectar</button>
    </div>

    <div v-if="tooltip.visible" class="global-tooltip" :style="{ top: tooltip.top, left: tooltip.left }">
        <strong>{{ tooltip.account.nickname }}</strong>
        <span>Status: {{ getStatusText(tooltip.account.status) }}</span>
        <span v-if="tooltip.account.status === 'error'">Causa: Necessita re-autenticação</span>
        <span v-if="tooltip.account.status === 'attention'">Causa: O token de acesso expira em breve.</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUpdate, onBeforeUnmount, watch, nextTick, computed } from 'vue';
import { useRoute } from 'vue-router';
import { useAuth } from '@/composables/useAuth';
import { useAdminMode } from '@/composables/useAdminMode';
import { useAdminMetrics } from '@/composables/useAdminMetrics';

const { user, userRole, fetchMercadoLivreAccounts } = useAuth();
const { isAdminMode } = useAdminMode();
const { metrics, isLoading: isLoadingMetrics, fetchMetrics } = useAdminMetrics();

watch(isAdminMode, (isNowAdmin) => {
  if (isNowAdmin) {
    fetchMetrics();
  }
}, { immediate: true });

const route = useRoute();
const navLinksRef = ref([]);
const slidingIndicatorStyle = ref({ top: '0px', height: '0px', opacity: 0 });

const baseNavItems = [
  { to: '/dashboard', text: 'Dashboard', iconOutline: '<path d="M12 13m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M13.45 11.55l2.05 -2.05" /><path d="M6.4 20a9 9 0 1 1 11.2 0z" />', iconSolid: '<path d="M12 13m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M13.45 11.55l2.05 -2.05" /><path d="M6.4 20a9 9 0 1 1 11.2 0z" />' },
  { to: '/tabela-vendas', text: 'Tabela de vendas', iconOutline: '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z" /><path d="M3 10h18" /><path d="M10 3v18" />', iconSolid: '<path d="M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z" /><path d="M3 10h18" /><path d="M10 3v18" />' },
  { to: '/contas', text: 'Contas', iconOutline: '<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" /><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /><path d="M21 21v-2a4 4 0 0 0 -3 -3.85" />', iconSolid: '<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" /><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /><path d="M21 21v-2a4 4 0 0 0 -3 -3.85" />' },
  { to: '/armazenamento', text: 'Armazenamento', iconOutline: '<path d="M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0" /><path d="M4 6v6a8 3 0 0 0 16 0v-6" /><path d="M4 12v6a8 3 0 0 0 16 0v-6" />', iconSolid: '<path d="M12 6m-8 0a8 3 0 1 0 16 0a8 3 0 1 0 -16 0" /><path d="M4 6v6a8 3 0 0 0 16 0v-6" /><path d="M4 12v6a8 3 0 0 0 16 0v-6" />' },
  { to: '/resumo-cobranca', text: 'Resumo de Cobrança', iconOutline: '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" /><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />', iconSolid: '<path d="M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z" /><path d="M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" />' },
];

const adminNavItems = [
    { to: '/admin', text: 'Painel Admin', iconOutline: '<path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3" /><path d="M12 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M12 12l0 2.5" />', iconSolid: '<path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3" /><path d="M12 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" /><path d="M12 12l0 2.5" />' },
    { to: '/admin/users', text: 'Usuários', iconOutline: '<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" /><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /><path d="M21 21v-2a4 4 0 0 0 -3 -3.85" />', iconSolid: '<path d="M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0" /><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /><path d="M21 21v-2a4 4 0 0 0 -3 -3.85" />' },
];

const navItems = computed(() => {
  if (userRole.value === 'master' && isAdminMode.value) {
    return adminNavItems;
  }
  return baseNavItems;
});

onBeforeUpdate(() => { navLinksRef.value = []; });

const updateIndicator = () => {
  const activeLink = navLinksRef.value.find(el => el && el.classList.contains('router-link-exact-active'));
  if (activeLink) {
    slidingIndicatorStyle.value = {
      top: `${activeLink.offsetTop}px`,
      height: `${activeLink.clientHeight}px`,
      opacity: 1
    };
  } else {
    slidingIndicatorStyle.value.opacity = 0;
  }
};

const handleNavLinkClick = (event) => {
  const icon = event.currentTarget.querySelector('.nav-icon');
  if (icon) {
    icon.classList.add('pulse-animation');
    setTimeout(() => icon.classList.remove('pulse-animation'), 300);
  }
};

watch(() => [route.path, navItems.value], () => { 
    nextTick(updateIndicator); 
}, { immediate: true, deep: true });

const connectedAccounts = ref([]);
const isLoadingAccounts = ref(true);
const accountsError = ref(null);
const isAccountsSectionCollapsed = ref(false);

async function fetchAccounts() {
  if (!user.value || !user.value.uid) {
    connectedAccounts.value = [];
    isLoadingAccounts.value = false;
    return;
  }
  isLoadingAccounts.value = true;
  accountsError.value = null;
  try {
    const accountsData = await fetchMercadoLivreAccounts();
    if (accountsData && accountsData.error) throw new Error(accountsData.error);
    
    connectedAccounts.value = (accountsData || []).map(acc => {
      if (acc.status === 'active' && acc.expires_in && acc.connected_at) {
        const expirationTime = new Date(acc.connected_at).getTime() + (acc.expires_in * 1000);
        const threeDaysInMillis = 3 * 24 * 60 * 60 * 1000;
        if ((expirationTime - Date.now()) < threeDaysInMillis) {
            return { ...acc, status: 'attention' };
        }
      }
      return acc;
    });
  } catch (err) {
    accountsError.value = err.message;
    connectedAccounts.value = [];
  } finally {
    isLoadingAccounts.value = false;
  }
}

function handleRetry() {
    fetchAccounts();
}

const getStatusText = (status) => {
  const map = { active: 'Ativa', attention: 'Atenção', error: 'Erro' };
  return map[status] || 'Inativa';
};

const contextMenu = ref({ visible: false, top: '0px', left: '0px', account: null });
const tooltip = ref({ visible: false, top: '0px', left: '0px', account: null });

const showContextMenu = (event, account) => {
    contextMenu.value = { visible: true, top: `${event.clientY}px`, left: `${event.clientX}px`, account };
};
const hideContextMenu = () => { if (contextMenu.value.visible) contextMenu.value.visible = false; };

const showTooltip = (event, account) => {
    const rect = event.currentTarget.getBoundingClientRect();
    tooltip.value = {
        visible: true,
        top: `${rect.top + rect.height / 2}px`,
        left: `${rect.right + 10}px`, 
        account
    };
};
const hideTooltip = () => { if (tooltip.value.visible) tooltip.value.visible = false; };

onMounted(() => {
  window.addEventListener('click', hideContextMenu);
  fetchAccounts();
});

onBeforeUnmount(() => {
    window.removeEventListener('click', hideContextMenu);
});

watch(() => route.fullPath, (newPath) => {
  if (newPath.startsWith('/contas') && newPath.includes('success=')) {
    fetchAccounts();
  }
}, { immediate: true });

</script>

<style scoped>
.sidebar {
  --font-family-sans: 'Inter', sans-serif;
  --color-bg: #ffffff;
  --color-border: #e5e7eb;
  --color-text-primary: #1f2937;
  --color-text-secondary: #6b7280;
  --color-primary: #6366f1;
  --color-primary-hover: #4f46e5;
  --color-success: #22c55e;
  --color-warning: #f97316;
  --color-danger: #ef4444;
  --color-neutral: #9ca3af;
  --sidebar-width: 250px;
}
.sidebar {
  width: var(--sidebar-width);
  min-height: 100vh;
  background-color: var(--color-bg);
  border-right: 1px solid var(--color-border);
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  font-family: var(--font-family-sans);
  position: relative;
  transition: margin-left 0.3s ease;
  flex-shrink: 0;
}
.sidebar-header { padding: 1.5rem; display: flex; justify-content: center; align-items: center; border-bottom: 1px solid var(--color-border);; }
.sidebar-logo { height: 40px; }
.sidebar-nav { display: flex; flex-direction: column; padding: 0.5rem; position: relative; }
.sliding-indicator {
  position: absolute; left: 0.5rem; width: 4px;
  background-color: var(--color-primary); border-radius: 4px;
  transition: top 0.3s cubic-bezier(0.4, 0, 0.2, 1), height 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  opacity: 0;
}
.nav-link {
  display: flex; align-items: center; padding: 0.75rem 1.5rem; margin: 0.25rem 0;
  font-size: 0.95rem; font-weight: 500; color: var(--color-text-secondary);
  text-decoration: none; border-radius: 8px; transition: color 0.2s, background-color 0.2s;
  position: relative; z-index: 2; border-left: 4px solid transparent;
}
.nav-link:hover { background-color: #f0f0f8; color: var(--color-text-primary); }
.nav-link.router-link-exact-active { color: var(--color-text-primary); font-weight: 700; }
.nav-icon { margin-right: 1rem; display: flex; align-items: center; transition: transform 0.2s ease; }
.nav-icon svg { width: 20px; height: 20px; }
.nav-icon.pulse-animation { animation: pulse-icon 0.3s ease-out; }
@keyframes pulse-icon { 50% { transform: scale(1.2); } }
.icon-solid { display: none; }
.icon-outline { display: block; }
.router-link-exact-active .icon-solid { display: block; }
.router-link-exact-active .icon-outline { display: none; }
.router-link-exact-active .nav-icon { color: var(--color-primary); }

.sidebar-bottom-section {
  border-top: 1px solid var(--color-border);
}

.account-status-header, .admin-metrics-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 1rem 1.5rem;
}
.account-status-title, .admin-metrics-title {
  font-size: 0.75rem; font-weight: 600; color: var(--color-neutral);
  text-transform: uppercase; letter-spacing: 0.05em; margin: 0;
}
.account-status-header { cursor: pointer; }
.collapse-icon { color: var(--color-neutral); transition: transform 0.3s ease; }
.collapse-icon.is-collapsed { transform: rotate(-90deg); }
.account-status-section {
  max-height: 500px; overflow: hidden;
  transition: max-height 0.4s ease-in-out, padding 0.4s ease-in-out;
  padding: 0 1.5rem 1.5rem 1.5rem;
}
.account-status-section.is-collapsed { max-height: 0; padding-top: 0; padding-bottom: 0; }
.account-status-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 1rem; }
.account-status-item {
  display: flex; align-items: center; font-size: 0.9rem;
  color: var(--color-text-primary); cursor: pointer;
}
.status-dot {
    width: 10px; height: 10px; border-radius: 50%;
    margin-right: 0.85rem; flex-shrink: 0;
    animation: pulse-dot 2.5s infinite cubic-bezier(0.4, 0, 0.6, 1);
}
.status-dot.active { background-color: var(--color-success); }
.status-dot.attention { background-color: var(--color-warning); }
.status-dot.error { background-color: var(--color-danger); }
@keyframes pulse-dot {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.2); opacity: 0.7; }
}
.add-account-button {
    width: 100%; display: flex; align-items: center; justify-content: center;
    gap: 0.5rem; margin-top: 1.5rem; padding: 0.5rem; font-size: 0.9rem;
    color: var(--color-text-secondary); background-color: transparent;
    border: 1px dashed var(--color-border); border-radius: 8px; cursor: pointer; transition: all 0.2s;
    text-decoration: none;
}
.add-account-button:hover { color: var(--color-primary); border-color: var(--color-primary); background-color: #f0f0f8; }
.retry-button { background: var(--color-primary); color: white; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; }
.retry-button:hover { background: var(--color-primary-hover); }
.status-list-skeleton { display: flex; flex-direction: column; gap: 1rem; }
.skeleton-item { display: flex; align-items: center; }
.skeleton-dot { width: 10px; height: 10px; border-radius: 50%; margin-right: 0.85rem; background-color: #e5e7eb; animation: pulse-bg 1.5s infinite; }
.skeleton-text { width: 80%; height: 14px; background-color: #e5e7eb; border-radius: 4px; animation: pulse-bg 1.5s infinite; }

.status-list-message {
  text-align: center;
  font-size: 0.875rem;
  color: var(--color-text-secondary);
  padding: 1rem 0;
}

.admin-metrics-section {
  padding: 0 1.5rem 1.5rem 1.5rem;
}
.metrics-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
.metric-item {
  background-color: #f9fafb;
  border-radius: 8px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.metric-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-primary);
}
.metric-value.has-errors {
  color: var(--color-danger);
}
.metric-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  margin-top: 0.25rem;
}
.metric-item-skeleton {
  background-color: #f3f4f6;
  border-radius: 8px;
  padding: 0.75rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  animation: pulse-bg 1.5s infinite;
}
.skeleton-value {
  width: 50%;
  height: 24px;
  background-color: #e5e7eb;
  border-radius: 4px;
  margin-bottom: 0.5rem;
}
.skeleton-label {
  width: 80%;
  height: 12px;
  background-color: #e5e7eb;
  border-radius: 4px;
}
@keyframes pulse-bg {
  50% { opacity: 0.6; }
}

.context-menu {
    position: fixed; z-index: 1000; background-color: var(--color-bg);
    border: 1px solid var(--color-border); border-radius: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.1); padding: 0.5rem; min-width: 180px;
    display: flex; flex-direction: column;
}
.context-menu-header {
    padding: 0.5rem 0.75rem; font-weight: 600; font-size: 0.9rem;
    border-bottom: 1px solid var(--color-border); margin-bottom: 0.5rem;
}
.context-menu-item {
    background: none; border: none; text-align: left;
    padding: 0.6rem 0.75rem; border-radius: 6px; font-size: 0.9rem; cursor: pointer;
}
.context-menu-item:hover { background-color: #f0f0f8; }
.context-menu-item.danger:hover { background-color: #fee2e2; color: var(--color-danger); }
.global-tooltip {
    position: fixed;
    transform: translateY(-50%);
    background-color: var(--color-text-primary);
    color: var(--color-bg);
    padding: 0.5rem 0.75rem;
    border-radius: 6px;
    font-size: 0.8rem;
    z-index: 2000;
    pointer-events: none;
    display: flex; flex-direction: column; gap: 0.25rem;
    transition: opacity 0.2s;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
}
@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    left: calc(var(--sidebar-width) * -1);
    z-index: 1000;
    height: 100%;
  }
  .sidebar.is-open {
      left: 0;
  }
}
</style>
