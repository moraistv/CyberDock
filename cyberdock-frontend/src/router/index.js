import { createRouter, createWebHistory } from 'vue-router';
import PaginaInicial from '../views/PaginaInicial.vue';
import AuthComponent from '../views/AuthComponent.vue';
import DashboardView from '../views/DashboardView.vue';
import ContasView from '../views/ContasView.vue';
import TabelaVendas from '../views/TabelaVendas.vue';
import ArmazenamentoView from '../views/ArmazenamentoView.vue';
import KitParentView from '../views/KitParentView.vue';
import ResumoCobranca from '../views/ResumoCobranca.vue';
import AdminView from '../views/AdminView.vue';
import ManageUsersView from '../views/ManageUsersView.vue';
import MasterResumoCobranca from '../views/MasterResumoCobranca.vue';
import ServiceHistory from '../views/ServiceHistory.vue';

const routes = [
  {
    path: '/',
    name: 'PaginaInicial',
    component: PaginaInicial,
  },
  {
    path: '/auth',
    name: 'Auth',
    component: AuthComponent,
    meta: { guest: true }
  },
  {
    path: '/dashboard',
    name: 'DashboardView',
    component: DashboardView,
    meta: { requiresAuth: true }
  },
  {
    path: '/admin',
    name: 'AdminView',
    component: AdminView,
    meta: { requiresAuth: true, requiresMaster: true }
  },
  {
    path: '/admin/users',
    name: 'ManageUsersView',
    component: ManageUsersView,
    meta: { requiresAuth: true, requiresMaster: true }
  },
  {
    path: '/admin/billing-summary',
    name: 'MasterResumoCobranca',
    component: MasterResumoCobranca,
    meta: { requiresAuth: true, requiresMaster: true }
  },
  {
    path: '/contas',
    name: 'ContasView',
    component: ContasView,
    meta: { requiresAuth: true }
  },
  {
    path: '/tabela-vendas',
    name: 'TabelaVendas',
    component: TabelaVendas,
    meta: { requiresAuth: true }
  },
  {
    path: '/armazenamento',
    name: 'ArmazenamentoView',
    component: ArmazenamentoView,
    meta: { requiresAuth: true }
  },
  {
    path: '/kits-pai',
    name: 'KitParentView',
    component: KitParentView,
    meta: { requiresAuth: true }
  },
  {
    path: '/resumo-cobranca',
    name: 'ResumoCobranca',
    component: ResumoCobranca,
    meta: { requiresAuth: true }
  },
  {
    path: '/admin/history',
    name: 'ServiceHistory',
    component: ServiceHistory,
    meta: { requiresAuth: true, requiresMaster: true }
  },
  {
    path: '/profile',
    name: 'Profile',
    // Idealmente, teria seu próprio componente, mas redirecionando para o dashboard
    component: DashboardView,
    meta: { requiresAuth: true }
  },
];

const router = createRouter({
  history: createWebHistory('/'),
  routes,
});

router.beforeEach(async (to, from, next) => {
  const requiresAuth = to.matched.some(record => record.meta.requiresAuth);
  const requiresMaster = to.matched.some(record => record.meta.requiresMaster);
  const isGuestRoute = to.matched.some(record => record.meta.guest);
  const token = localStorage.getItem('authToken');

  function parseJwt(token) {
    if (!token) return null;
    try {
      return JSON.parse(atob(token.split('.')[1]));
    } catch (e) {
      return null;
    }
  }

  const payload = parseJwt(token);
  const isAuthenticated = payload && payload.exp * 1000 > Date.now();
  const userRole = payload ? payload.role : null;

  if (requiresAuth && !isAuthenticated) {
    next('/auth');
  } else if (requiresMaster && userRole !== 'master') {
    next('/dashboard'); // Redireciona se não for master
  } else if (isGuestRoute && isAuthenticated) {
    next('/dashboard');
  } else {
    next();
  }
});

export default router;
