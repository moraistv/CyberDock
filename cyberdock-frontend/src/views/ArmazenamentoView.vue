<template>
    <div class="dashboard-wrapper">
        <SidebarComponent />
        <div class="main-content">
            <TopbarComponent />
            <div class="dashboard-content">
                <div class="header">
                    <div class="header-content">
                        <h1 class="dashboard-title">
                            Painel de Armazenamento
                            <span v-if="props.userId && props.userId !== user?.value?.uid" class="user-indicator">
                                (Usuário: {{ props.userId }})
                            </span>
                        </h1>
                        <p class="dashboard-subtitle">
                            <span v-if="props.userId && props.userId !== user?.value?.uid">
                                Acompanhando o consumo do espaço de armazenamento e gerenciando SKUs do usuário selecionado.
                            </span>
                            <span v-else>
                                Acompanhe o consumo do seu espaço de armazenamento e gerencie seus SKUs.
                            </span>
                        </p>
                    </div>
                    <div class="header-actions">
                        <button @click="openStorageModal" class="btn btn-primary">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3" />
                                <path d="M12 11m-1 0a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
                                <path d="M12 12l0 2.5" />
                            </svg>
                            Gerenciar Estoque
                        </button>
                    </div>
                </div>

                <div v-if="isLoading" class="loading-state">
                    <p>Carregando seus dados de armazenamento...</p>
                </div>

                <div v-else>
                    <!-- Grid de cards atualizado e funcional -->
                    <div class="stats-cards-grid-small">
                        <div class="stat-card">
                            <h3 class="card-title">Previsão de Custo</h3>
                             <div v-if="billingSummary.isLoading" class="loading-billing">Calculando...</div>
                            <div v-else-if="billingSummary.error" class="error-billing">{{ billingSummary.error }}</div>
                            <div v-else-if="billingSummary.data">
                                <p class="metric-value total-cost">{{ formatCurrency(billingSummary.data.totalCost) }}</p>
                                <p class="card-description-small">
                                    Base: {{ formatCurrency(billingSummary.data.baseCost) }}
                                    <span v-if="billingSummary.data.additionalCost > 0"><br>+ Adic: {{ formatCurrency(billingSummary.data.additionalCost) }}</span>
                                </p>
                            </div>
                        </div>
                        <div class="stat-card">
                            <h3 class="card-title">Volume Consumido</h3>
                            <p class="metric-value">{{ volumeConsumido.toFixed(4) }} <span class="metric-unit">m³</span></p>
                             <p class="card-description-small">de {{ volumeContratado.toFixed(2) }} m³ contratado</p>
                        </div>
                        <div class="stat-card">
                            <h3 class="card-title">% de Ocupação</h3>
                            <p class="metric-value">{{ percentualOcupacao.toFixed(1) }}<span class="metric-unit">%</span></p>
                            <div class="progress-bar-container">
                                <div class="progress-bar" :style="{ width: percentualOcupacao + '%' }"></div>
                            </div>
                        </div>
                        <div class="stat-card">
                            <h3 class="card-title">Vendas Expedidas</h3>
                            <p class="metric-value">{{ expeditedSalesCount }}</p>
                            <p class="card-description-small">Total de vendas com status "Despachado".</p>
                        </div>
                        <div class="stat-card package-summary-card">
                            <h3 class="card-title">Estoque por Pacote</h3>
                            <div v-if="quantityByPackageType.length > 0" class="package-list">
                                <div v-for="pkg in quantityByPackageType" :key="pkg.name" class="package-item">
                                    <span>{{ pkg.name }}</span>
                                    <span class="package-quantity">{{ pkg.quantity }} un.</span>
                                </div>
                            </div>
                            <p v-else class="card-description-small">Nenhum item em estoque.</p>
                        </div>
                    </div>

                    <div class="table-container">
                        <h2 class="table-title">Seus SKUs Armazenados</h2>
                        <table class="sku-table">
                            <thead>
                                <tr>
                                    <th>SKU</th>
                                    <th>Descrição</th>
                                    <th>Dimensões (cm)</th>
                                    <th>Qtd. em Estoque</th>
                                    <th>Volume Total (m³)</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="sku in allItemsForDisplay" :key="sku.id" :class="{ 'kit-row': sku.is_kit }">
                                    <td class="sku-code">{{ sku.sku }}</td>
                                    <td>{{ sku.descricao }}</td>
                                    <td>{{ `${sku.dimensoes.altura} x ${sku.dimensoes.largura} x ${sku.dimensoes.comprimento}` }}</td>
                                    <td>
                                        <span v-if="sku.is_kit" class="kit-no-qty">—</span>
                                        <span v-else>{{ sku.quantidade }}</span>
                                    </td>
                                    <td>{{ calcularVolumePorSku(sku).toFixed(4) }}</td>
                                </tr>
                                <tr v-if="allItemsForDisplay.length === 0">
                                    <td colspan="5" class="empty-state">Nenhum SKU em estoque para exibir.</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>

                    <StockMovementsTable :movements="allMovements" :is-loading="isLoadingMovements" @delete="handleDeleteMovement" />
                </div>
            </div>
        </div>
        
        <!-- Storage Management Modal -->
        <UniversalModal
            :title="'Gerenciar Estoque'"
            :is-open="isStorageModalOpen"
            size="xl"
            @close="closeStorageModal"
        >
            <div class="storage-management">
                <!-- Action Buttons -->
                <div class="storage-actions">
                    <button @click="openSkuModal" class="btn btn-primary">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 5v14M5 12h14"/>
                        </svg>
                        Criar SKU Individual
                    </button>
                    
                    <button @click="$router.push('/kits-pai')" class="btn btn-secondary">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" />
                            <path d="M2 13.5v5.5l5 3" />
                            <path d="M7 16.545l5 -3.03" />
                        </svg>
                        Gerenciar Kits Pai
                    </button>
                    
                    <button @click="openKitManagementModal" class="btn btn-accent">
                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" />
                            <path d="M2 13.5v5.5l5 3" />
                            <path d="M7 16.545l5 -3.03" />
                            <path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" />
                            <path d="M12 19l5 3" />
                            <path d="M17 16.5l5 -3" />
                        </svg>
                        Gerenciar Kits
                    </button>
                    
                    <button @click="testKitParents" class="btn" style="background: #f59e0b; color: white;">
                        🔍 Testar Kit Parents
                    </button>
                </div>
                
                <!-- Hierarquia de Kits e SKUs -->
                <div class="hierarchy-section">
                    <h3 class="section-title">
                        🏗️ Hierarquia de Kits e SKUs
                        <span class="item-count">({{ hierarchyItems.length }} grupos)</span>
                    </h3>
                    <div class="table-container">
                        <table class="hierarchy-table">
                            <thead>
                                <tr>
                                    <th class="hierarchy-col">Hierarquia</th>
                                    <th>Descrição</th>
                                    <th>Tipo</th>
                                    <th>Volume (m³)</th>
                                    <th>Quantidade</th>
                                    <th>Ações</th>
                                </tr>
                            </thead>
                            <tbody>
                                <template v-for="item in hierarchyItems" :key="item.id">
                                    <!-- Kit Pai -->
                                    <tr v-if="item.type === 'kit-parent'" class="kit-parent-row">
                                        <td class="hierarchy-col">
                                            <div class="kit-parent-item">
                                                <span class="hierarchy-icon"><svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-packages"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M2 13.5v5.5l5 3" /><path d="M7 16.545l5 -3.03" /><path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M12 19l5 3" /><path d="M17 16.5l5 -3" /><path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5" /><path d="M7 5.03v5.455" /><path d="M12 8l5 -3" /></svg></span>
                                                <span class="sku-code kit-parent-code">{{ item.nome }}</span>
                                            </div>
                                        </td>
                                        <td>{{ item.descricao }}</td>
                                        <td>
                                            <span class="kit-status" :class="item.ativo ? 'active' : 'inactive'">
                                                Kit Pai {{ item.ativo ? 'Ativo' : 'Inativo' }}
                                            </span>
                                        </td>
                                        <td>0.0000</td>
                                        <td>{{ item.children.length }} SKUs</td>
                                        <td>
                                            <div class="action-buttons">
                                                <button @click="$router.push('/kits-pai')" class="btn-icon" title="Gerenciar Kit Pai">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                        <path d="M12 20h9"/>
                                                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                                    </svg>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                    
                                    <!-- Kit Composto -->
                                    <tr v-if="item.type === 'kit-composto'" class="kit-composto-row">
                                        <td class="hierarchy-col">
                                            <div class="kit-composto-item">
                                                <span class="hierarchy-icon"><svg  xmlns="http://www.w3.org/2000/svg"  width="24"  height="24"  viewBox="0 0 24 24"  fill="none"  stroke="currentColor"  stroke-width="2"  stroke-linecap="round"  stroke-linejoin="round"  class="icon icon-tabler icons-tabler-outline icon-tabler-packages"><path stroke="none" d="M0 0h24v24H0z" fill="none"/><path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M2 13.5v5.5l5 3" /><path d="M7 16.545l5 -3.03" /><path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z" /><path d="M12 19l5 3" /><path d="M17 16.5l5 -3" /><path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5" /><path d="M7 5.03v5.455" /><path d="M12 8l5 -3" /></svg></span>
                                                <span class="sku-code kit-composto-code">{{ item.sku }}</span>
                                            </div>
                                        </td>
                                        <td>{{ item.descricao }}</td>
                                        <td>
                                            <span class="kit-status" :class="item.ativo ? 'active' : 'inactive'">
                                                Kit Composto {{ item.ativo ? 'Ativo' : 'Inativo' }}
                                            </span>
                                        </td>
                                        <td>0.0000</td>
                                        <td>{{ item.available_kit_quantity || 0 }}</td>
                                        <td>
                                            <div class="action-buttons">
                                                <button @click="editSku(item)" class="btn-icon" title="Editar Kit">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                        <path d="M12 20h9"/>
                                                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                                    </svg>
                                                </button>
                                                <button @click="deleteSku(item)" class="btn-icon delete" title="Excluir Kit">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                        <path d="M3 6h18"/>
                                                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                                                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                                        <line x1="10" x2="10" y1="11" y2="17"/>
                                                        <line x1="14" x2="14" y1="11" y2="17"/>
                                                    </svg>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                    
                                    <!-- SKUs Filhos do Kit -->
                                    <tr v-for="child in item.children" :key="child.id" class="child-sku-row">
                                        <td class="hierarchy-col">
                                            <div class="child-sku-item">
                                                <div class="hierarchy-line"></div>
                                                <span class="hierarchy-icon child-icon">📄</span>
                                                <span class="sku-code child-code">{{ child.sku }}</span>
                                            </div>
                                        </td>
                                        <td>{{ child.descricao }}</td>
                                        <td>
                                            <span class="child-badge">SKU Filho</span>
                                        </td>
                                        <td>{{ calcularVolumePorSku(child).toFixed(4) }}</td>
                                        <td>{{ child.quantidade }}</td>
                                        <td>
                                            <div class="action-buttons">
                                                <button @click="editSku(child)" class="btn-icon" title="Editar SKU">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                        <path d="M12 20h9"/>
                                                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                                    </svg>
                                                </button>
                                                <button @click="openAdjustStockModal(child)" class="btn-icon" title="Ajustar Estoque">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                        <path d="M12 5v14M5 12h14"/>
                                                    </svg>
                                                </button>
                                                <button @click="deleteSku(child)" class="btn-icon delete" :disabled="child.quantidade > 0" :title="child.quantidade > 0 ? 'Não é possível excluir SKU com estoque' : 'Excluir SKU'">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                        <path d="M3 6h18"/>
                                                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                                                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                                        <line x1="10" x2="10" y1="11" y2="17"/>
                                                        <line x1="14" x2="14" y1="11" y2="17"/>
                                                    </svg>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                    
                                    <!-- SKU Órfão (sem kit pai) -->
                                    <tr v-if="item.type === 'orphan'" class="orphan-sku-row">
                                        <td class="hierarchy-col">
                                            <div class="orphan-sku-item">
                                                <span class="hierarchy-icon">📄</span>
                                                <span class="sku-code orphan-code">{{ item.sku }}</span>
                                            </div>
                                        </td>
                                        <td>{{ item.descricao }}</td>
                                        <td>
                                            <span class="orphan-badge">Individual</span>
                                        </td>
                                        <td>{{ calcularVolumePorSku(item).toFixed(4) }}</td>
                                        <td>{{ item.quantidade }}</td>
                                        <td>
                                            <div class="action-buttons">
                                                <button @click="editSku(item)" class="btn-icon" title="Editar SKU">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                        <path d="M12 20h9"/>
                                                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                                    </svg>
                                                </button>
                                                <button @click="openAdjustStockModal(item)" class="btn-icon" title="Ajustar Estoque">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                        <path d="M12 5v14M5 12h14"/>
                                                    </svg>
                                                </button>
                                                <button @click="deleteSku(item)" class="btn-icon delete" :disabled="item.quantidade > 0" :title="item.quantidade > 0 ? 'Não é possível excluir SKU com estoque' : 'Excluir SKU'">
                                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                        <path d="M3 6h18"/>
                                                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                                                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
                                                        <line x1="10" x2="10" y1="11" y2="17"/>
                                                        <line x1="14" x2="14" y1="11" y2="17"/>
                                                    </svg>
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                </template>
                                
                                <tr v-if="hierarchyItems.length === 0">
                                    <td colspan="6" class="empty-state">Nenhum item criado ainda.</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
            
            <template #footer>
                <div class="modal-actions">
                    <button @click="closeStorageModal" type="button" class="btn btn-secondary">Fechar</button>
                </div>
            </template>
        </UniversalModal>
        
        <!-- SKU Form Modal -->
        <SkuFormModal
            :is-open="isSkuModalOpen"
            :is-editing="isEditingSku"
            :sku-data="currentSku"
            :package-types="packageTypes"
            :active-kit-parents="activeKitParents"
            :active-kits="activeKits"
            @close="closeSkuModal"
            @save="handleSkuSave"
            @open-package-select="openPackageSelect"
        />
        
        <!-- Kit Management Modal -->
        <KitManagementModal
            :is-open="isKitManagementModalOpen"
            :package-types="packageTypes"
            :available-skus="availableChildSkus"
            :user-id="userId"
            @close="closeKitManagementModal"
            @kit-created="handleKitCreated"
            @kit-updated="handleKitUpdated"
            @kit-deleted="handleKitDeleted"
        />
        
        <!-- Adjust Stock Modal -->
        <AdjustStockModal
            :is-open="isAdjustStockModalOpen"
            :sku="skuToAdjust"
            @close="closeAdjustStockModal"
            @confirm="handleConfirmAdjustment"
        />
        

    </div>
</template>

<script setup>
/* eslint-disable no-undef */
import { computed, ref, watch } from 'vue';
import SidebarComponent from '../components/SidebarComponent.vue';
import TopbarComponent from '../components/TopbarComponent.vue';
import StockMovementsTable from '../components/StockMovementsTable.vue';
import UniversalModal from '../components/UniversalModal.vue';
import SkuFormModal from '../components/StorageComponents/SkuFormModal.vue';
import AdjustStockModal from '../components/StorageComponents/AdjustStockModal.vue';
import KitManagementModal from '../components/StorageComponents/KitManagementModal.vue';
import { useAuth } from '@/composables/useAuth';
import { useUserStorage } from '@/composables/useUserStorage';
import { useSalesForUser } from '@/composables/useSalesForUser';
import { useKitParent } from '@/composables/useKitParent';
import { useKitManagement } from '@/composables/useKitManagement';

// Props para permitir que masters acessem armazenamento de outros usuários
const props = defineProps({
  userId: {
    type: String,
    default: null
  }
});

const { user, isAuthReady } = useAuth();

// Computed userId: se prop fornecida, usa ela; senão, usa o usuário logado
const userId = computed(() => {
  console.log('🔍 [ArmazenamentoView] Computando userId...');
  console.log('🔍 [ArmazenamentoView] isAuthReady:', isAuthReady.value);
  console.log('🔍 [ArmazenamentoView] props.userId:', props.userId);
  console.log('🔍 [ArmazenamentoView] user.value?.uid:', user.value?.uid);
  
  // Se uma prop userId foi fornecida (para masters acessarem outros usuários), usa ela
  if (props.userId) {
    console.log('✅ [ArmazenamentoView] Usando userId da prop:', props.userId);
    return props.userId;
  }
  
  // Senão, usa o userId do usuário logado
  const uid = user.value?.uid;
  if (!uid) {
    console.warn('⚠️ [ArmazenamentoView] userId não disponível');
  }
  return uid;
});

// Debug: observar userId
watch(userId, () => {
  // console.log('🎯 ArmazenamentoView - userId alterado');
}, { immediate: true });

const { 
    skus, 
    isLoading, 
    volumeConsumido, 
    percentualOcupacao, 
    calcularVolumePorSku,
    billingSummary,
    volumeContratado,
    allMovements,
    isLoadingMovements,
    packageTypes,
    addSku,
    updateSku,
    removeSku,
    adjustStock,
    deleteMovement
} = useUserStorage(userId);

const {
    activeKitParents,
    loadActiveKitParents
} = useKitParent(userId);

// Debug: observar mudanças em activeKitParents
watch(activeKitParents, (newValue) => {
    console.log('🔥 ArmazenamentoView - activeKitParents alterou:', newValue);
    console.log('🔥 ArmazenamentoView - Quantidade de kits:', newValue?.length || 0);
}, { immediate: true, deep: true });

const {
    activeKits,
    availableChildSkus,
    loadAvailableChildSkus
} = useKitManagement(userId);

const { sales } = useSalesForUser(userId);

// Modal states
const isStorageModalOpen = ref(false);
const isSkuModalOpen = ref(false);
const isEditingSku = ref(false);
const currentSku = ref(null);
const isKitManagementModalOpen = ref(false);
const isAdjustStockModalOpen = ref(false);
const skuToAdjust = ref(null);

// Kit Management Modal Methods
const openKitManagementModal = async () => {
    console.log('🔍 [ArmazenamentoView] Abrindo modal de gestão de kits...');
    console.log('🔍 [ArmazenamentoView] userId atual:', userId.value);
    console.log('🔍 [ArmazenamentoView] isKitManagementModalOpen antes:', isKitManagementModalOpen.value);
    
    isKitManagementModalOpen.value = true;
    console.log('🔍 [ArmazenamentoView] isKitManagementModalOpen após:', isKitManagementModalOpen.value);
    
    // Carregar SKUs disponíveis quando abrir o modal
    try {
        await loadAvailableChildSkus();
        console.log('✅ [ArmazenamentoView] SKUs carregados com sucesso');
    } catch (error) {
        console.error('❌ [ArmazenamentoView] Erro ao carregar SKUs:', error);
    }
};

const closeKitManagementModal = () => {
    isKitManagementModalOpen.value = false;
};

const handleKitCreated = async () => {
    // Recarregar kits ativos quando um novo kit for criado
    await loadActiveKitParents();
};

const handleKitUpdated = async () => {
    // Recarregar kits ativos quando um kit for atualizado
    await loadActiveKitParents();
};

const handleKitDeleted = async () => {
    // Recarregar kits ativos quando um kit for excluído
    await loadActiveKitParents();
};

// Storage Modal Methods
const openStorageModal = async () => {
    console.log('📋 [ArmazenamentoView] Abrindo modal de storage');
    // Carregar Kit Parents antes de abrir o modal
    await loadActiveKitParents();
    console.log('📋 [ArmazenamentoView] Kit Parents carregados para storage modal:', activeKitParents.value);
    isStorageModalOpen.value = true;
};

const closeStorageModal = () => {
    isStorageModalOpen.value = false;
};

// SKU Modal Methods
const openSkuModal = async () => {
    console.log('📝 [ArmazenamentoView] Abrindo modal SKU');
    // Forçar carregamento dos Kit Parents antes de abrir o modal
    await loadActiveKitParents();
    console.log('📝 [ArmazenamentoView] activeKitParents após carregamento:', activeKitParents.value);
    isEditingSku.value = false;
    currentSku.value = null;
    isSkuModalOpen.value = true;
};

const editSku = (sku) => {
    isEditingSku.value = true;
    currentSku.value = { ...sku };
    isSkuModalOpen.value = true;
};

const closeSkuModal = () => {
    isSkuModalOpen.value = false;
    isEditingSku.value = false;
    currentSku.value = null;
};

const handleSkuSave = async (skuData) => {
    try {
        if (isEditingSku.value) {
            await updateSku(currentSku.value.id, skuData);
            showToast('SKU atualizado com sucesso!', 'success');
        } else {
            await addSku(skuData);
            showToast('SKU criado com sucesso!', 'success');
        }
        
        // Recarregar kit parents ativos para atualizar a hierarquia
        await loadActiveKitParents();
        
        closeSkuModal();
    } catch (error) {
        showToast(error.message || 'Erro ao salvar SKU', 'error');
    }
};

// Package selection (placeholder)
const openPackageSelect = (data) => {
    console.log('Package select:', data);
};

// Função de teste para diagnosticar Kit Parents
const testKitParents = async () => {
    console.log('🔍 [TESTE] Iniciando diagnóstico de Kit Parents');
    console.log('🔍 [TESTE] userId atual:', userId.value);
    console.log('🔍 [TESTE] activeKitParents.value antes do carregamento:', activeKitParents.value);
    
    try {
        // Forçar carregamento
        await loadActiveKitParents();
        
        console.log('✅ [TESTE] Carregamento concluído');
        console.log('✅ [TESTE] activeKitParents.value após carregamento:', activeKitParents.value);
        console.log('✅ [TESTE] Quantidade de Kit Parents:', activeKitParents.value?.length || 0);
        
        if (activeKitParents.value && activeKitParents.value.length > 0) {
            console.log('✅ [TESTE] Kit Parents encontrados:');
            activeKitParents.value.forEach((kit, index) => {
                console.log(`  ${index + 1}. ID: ${kit.id}, Nome: ${kit.nome}, Descrição: ${kit.descricao}`);
            });
            showToast(`✅ ${activeKitParents.value.length} Kit Parent(s) encontrado(s)!`, 'success');
        } else {
            console.log('⚠️ [TESTE] Nenhum Kit Parent encontrado');
            showToast('⚠️ Nenhum Kit Parent encontrado. Crie um primeiro.', 'warning');
        }
    } catch (error) {
        console.error('❌ [TESTE] Erro ao carregar Kit Parents:', error);
        showToast(`❌ Erro: ${error.message}`, 'error');
    }
};

// Delete SKU function
const deleteSku = async (sku) => {
    const confirmMessage = `Tem certeza que deseja excluir o SKU "${sku.sku}"?\n\nEsta ação não pode ser desfeita.`;
    
    if (confirm(confirmMessage)) {
        try {
            await removeSku(sku.id);
            showToast('SKU excluído com sucesso!', 'success');
        } catch (error) {
            showToast(error.message || 'Erro ao excluir SKU', 'error');
        }
    }
};

// Adjust Stock function (placeholder for now)
const openAdjustStockModal = (sku) => {
    skuToAdjust.value = sku;
    isAdjustStockModalOpen.value = true;
};

const closeAdjustStockModal = () => {
    isAdjustStockModalOpen.value = false;
    skuToAdjust.value = null;
};

const handleConfirmAdjustment = async ({ movementType, quantityChange, reason }) => {
    try {
        await adjustStock(skuToAdjust.value, movementType, quantityChange, reason);
        closeAdjustStockModal();
        showToast('Estoque ajustado com sucesso!', 'success');
    } catch (error) {
        showToast(error.message || 'Erro ao ajustar estoque', 'error');
    }
};

// Handler para exclusão de movimentação (vinda do componente de tabela)
const handleDeleteMovement = async (movementId) => {
    if (!movementId) return;
    try {
        await deleteMovement(movementId);
        showToast('Movimentação excluída com sucesso!', 'success');
    } catch (error) {
        showToast(error.message || 'Erro ao excluir movimentação', 'error');
    }
};

// Computed property for hierarchical structure
const hierarchyItems = computed(() => {
    const items = [];
    const kitParentMap = new Map();
    
    // Primeiro, criar mapa de kit parents ativos (organização hierárquica)
    const kitParents = activeKitParents.value || [];
    kitParents.forEach(kitParent => {
        kitParentMap.set(kitParent.id, {
            ...kitParent,
            sku: `KIT-PARENT-${kitParent.id}`, // Kit parents não têm SKU, criamos um identificador
            type: 'kit-parent',
            children: [],
            dimensoes: { altura: 0, largura: 0, comprimento: 0 }, // Kit parents não têm dimensões
            ativo: kitParent.ativo || true
        });
    });
    
    // Adicionar kits compostos como itens separados (se existirem)
    const kitsCompostos = activeKits.value || [];
    kitsCompostos.forEach(kit => {
        items.push({
            ...kit,
            type: 'kit-composto'
        });
    });
    
    // Organizar SKUs individuais por kit pai
    const individualSkus = (skus.value || []).filter(sku => !sku.is_kit);
    
    individualSkus.forEach(sku => {
        if (sku.kit_parent_id && kitParentMap.has(sku.kit_parent_id)) {
            // SKU tem kit pai - adicionar como filho
            kitParentMap.get(sku.kit_parent_id).children.push(sku);
        } else {
            // SKU órfão - adicionar diretamente
            items.push({
                ...sku,
                type: 'orphan'
            });
        }
    });
    
    // Adicionar kit parents com filhos ao início da lista
    kitParentMap.forEach(kitParent => {
        items.unshift(kitParent);
    });
    
    return items;
});

// Toast notification helper
const showToast = (message, type = 'info') => {
    window.dispatchEvent(new CustomEvent('show-toast', {
        detail: { 
            id: `${type}-${Date.now()}`, 
            message, 
            type, 
            duration: 3000 
        }
    }));
};

const expeditedSalesCount = computed(() => {
    if (!sales.value) return 0;
    // Filtra pelo status 'custom_06_despachado'
    return sales.value.filter(s => s.shipping_status === 'custom_06_despachado').length;
});

const quantityByPackageType = computed(() => {
  if (!skus.value || skus.value.length === 0) {
    return [];
  }
  const summary = skus.value.reduce((acc, sku) => {
    const typeName = sku.package_type_name;
    // Garante que apenas pacotes 'Comum' e 'Premium' sejam contados
    if (typeName === 'Expedição Comum' || typeName === 'Expedição Premium') {
        if (!acc[typeName]) {
          acc[typeName] = 0;
        }
        acc[typeName] += sku.quantidade;
    }
    return acc;
  }, {});

  return Object.entries(summary)
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => b.quantity - a.quantity);
});


const formatCurrency = (value) => {
    if (typeof value !== 'number') return 'R$ 0,00';
    return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

// Combinar SKUs individuais com kits ativos para exibição
const allItemsForDisplay = computed(() => {
    // SKUs individuais (não kits)
    const individualSkus = skus.value?.filter(sku => !sku.is_kit) || []
    
    // Kits ativos com informação de estoque calculado
    const activeKitsForDisplay = activeKits.value?.map(kit => ({
        ...kit,
        quantidade: kit.available_quantity || 0,
        is_kit: true
    })) || []
    
    // Combinar e ordenar por SKU
    return [...individualSkus, ...activeKitsForDisplay]
        .sort((a, b) => a.sku.localeCompare(b.sku))
});
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
.dashboard-wrapper { display: flex; min-height: 100vh; font-family: 'Inter', sans-serif; background-color: #f3f4f6; }
.main-content { flex: 1; display: flex; flex-direction: column; }
.dashboard-content { flex: 1; padding: 2rem; }

.header { 
    margin-bottom: 2rem; 
    display: flex; 
    justify-content: space-between; 
    align-items: flex-start; 
    gap: 2rem; 
}

.header-content {
    flex: 1;
}

.header-actions {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
}

.btn {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
    border: none;
    font-weight: 500;
    font-size: 0.875rem;
    cursor: pointer;
    transition: all 0.2s;
    white-space: nowrap;
}

.btn-primary {
    background-color: #2563eb;
    color: white;
}

.btn-primary:hover {
    background-color: #1d4ed8;
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
}
.dashboard-title { font-size: 1.875rem; font-weight: 700; color: #111827; }
.dashboard-subtitle { margin-top: 0.25rem; font-size: 0.875rem; color: #6b7280; }
.loading-state { text-align: center; padding: 4rem; color: #6b7280; }

.stats-cards-grid-small { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2.5rem; }
.stat-card { background-color: #ffffff; border-radius: 0.75rem; padding: 1.25rem; border: 1px solid #e5e7eb; display: flex; flex-direction: column; }
.card-title { font-size: 0.875rem; font-weight: 600; color: #374151; margin: 0 0 0.75rem 0; }
.metric-value { font-size: 1.75rem; font-weight: 700; color: #111827; line-height: 1.2; }
.metric-unit { font-size: 1rem; font-weight: 500; color: #6b7280; margin-left: 0.25rem; }
.card-description-small { font-size: 0.75rem; color: #6b7280; margin: 0.25rem 0 0 0; }
/* [CORREÇÃO] Ajuste no container da barra de progresso */
.progress-bar-container { width: 100%; background-color: #e5e7eb; border-radius: 9999px; height: 8px; overflow: hidden; margin-top: auto; }
.progress-bar { height: 100%; background-color: #2563eb; border-radius: 9999px; }

.package-summary-card { gap: 0.5rem; }
.package-list { display: flex; flex-direction: column; gap: 0.4rem; font-size: 0.8rem; }
.package-item { display: flex; justify-content: space-between; align-items: center; }
.package-quantity { font-weight: 600; color: #111827; }

.table-container { background-color: #ffffff; border-radius: 0.75rem; box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1); }
.table-title { font-size: 1.25rem; font-weight: 600; padding: 1.5rem; border-bottom: 1px solid #e5e7eb; }
.sku-table { width: 100%; border-collapse: collapse; }
.sku-table th, .sku-table td { padding: 1rem 1.5rem; border-bottom: 1px solid #e5e7eb; }
.sku-table thead th { font-size: 0.75rem; font-weight: 600; color: #6b7280; text-transform: uppercase; background-color: #f9fafb; }
.sku-table tbody tr:last-child td { border-bottom: none; }
.sku-code { font-weight: 600; color: #2563eb; }
.empty-state { text-align: center; padding: 3rem; color: #6b7280; }
.total-cost { color: #16a34a; }
.loading-billing, .error-billing { color: #6b7280; font-style: italic; }
.error-billing { color: #ef4444; }

/* Estilos para quantidades de kits */
.kit-quantity {
  color: #059669;
  font-weight: 600;
}

.kit-no-components {
  color: #6b7280;
  font-style: italic;
  font-size: 0.875rem;
}

.kit-no-qty {
  color: #9ca3af;
  font-size: 1.2rem;
  font-weight: 300;
}

/* Storage Management Modal Styles */
.storage-management {
    display: flex;
    flex-direction: column;
    gap: 2rem;
}

.storage-actions {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
}

.btn-secondary {
    background-color: #6b7280;
    color: white;
}

.btn-secondary:hover {
    background-color: #4b5563;
}

.btn-accent {
    background-color: #7c3aed;
    color: white;
}

.btn-accent:hover {
    background-color: #6d28d9;
}

.kit-parents-section {
    background-color: #f9fafb;
    padding: 1.5rem;
    border-radius: 0.75rem;
    border: 1px solid #e5e7eb;
}

.kit-parents-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1rem;
}

.kit-parent-card {
    background-color: white;
    padding: 1.25rem;
    border-radius: 0.5rem;
    border: 1px solid #e5e7eb;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
}

.kit-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 0.75rem;
}

.kit-header h4 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: #111827;
}

.kit-status {
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
}

.kit-status.active {
    background-color: #dcfce7;
    color: #166534;
}

.kit-status.inactive {
    background-color: #fef2f2;
    color: #991b1b;
}

.kit-description {
    color: #6b7280;
    font-size: 0.875rem;
    margin-bottom: 1rem;
}

.kit-actions {
    display: flex;
    gap: 0.5rem;
}

.btn-icon {
    padding: 0.5rem;
    border: none;
    border-radius: 0.375rem;
    cursor: pointer;
    transition: all 0.2s;
    background-color: #eff6ff;
    color: #1d4ed8;
}

.btn-icon:hover:not(:disabled) {
    transform: scale(1.05);
}

.btn-icon.delete {
    background-color: #fef2f2;
    color: #dc2626;
}

.btn-icon:disabled {
    opacity: 0.5;
    cursor: not-allowed;
    transform: none;
}

.btn-icon:disabled:hover {
    transform: none;
}

.skus-section {
    background-color: #f9fafb;
    padding: 1.5rem;
    border-radius: 0.75rem;
    border: 1px solid #e5e7eb;
    margin-bottom: 1.5rem;
}

.kits-section {
    background-color: #faf5ff;
    padding: 1.5rem;
    border-radius: 0.75rem;
    border: 1px solid #e5e7eb;
    margin-bottom: 1.5rem;
}

.hierarchy-section {
    background: linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%);
    padding: 1.5rem;
    border-radius: 0.75rem;
    border: 1px solid #e2e8f0;
    margin-bottom: 1.5rem;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
}

.hierarchy-table {
    width: 100%;
    border-collapse: collapse;
    background: white;
    border-radius: 0.5rem;
    overflow: hidden;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
}

.hierarchy-col {
    width: 250px;
    min-width: 250px;
}

/* Kit Pai Styles */
.kit-parent-row {
    background: linear-gradient(135deg, #fef7ff 0%, #faf5ff 100%);
    border-bottom: 2px solid #e879f9;
}

.kit-parent-row:hover {
    background: linear-gradient(135deg, #fdf4ff 0%, #f3e8ff 100%);
}

.kit-parent-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    font-weight: 600;
}

.kit-parent-code {
    color: #7c3aed;
    font-weight: 700;
    font-size: 1rem;
}

/* Kit Composto Styles */
.kit-composto-row {
    background: linear-gradient(135deg, #fff7ed 0%, #ffedd5 100%);
    border-bottom: 2px solid #fb923c;
}

.kit-composto-row:hover {
    background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
}

.kit-composto-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
    font-weight: 600;
}

.kit-composto-code {
    color: #ea580c;
    font-weight: 700;
    font-size: 1rem;
}

/* SKU Filho Styles */
.child-sku-row {
    background: #fefefe;
    border-bottom: 1px solid #f1f5f9;
    position: relative;
}

.child-sku-row:hover {
    background: #f8fafc;
}

.child-sku-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    padding-left: 2rem;
    position: relative;
}

.hierarchy-line {
    position: absolute;
    left: 1.5rem;
    top: 0;
    bottom: 0;
    width: 2px;
    background: linear-gradient(to bottom, #e879f9 0%, #c084fc 50%, #d1d5db 100%);
}

.hierarchy-line::before {
    content: '';
    position: absolute;
    top: 50%;
    right: -8px;
    width: 16px;
    height: 2px;
    background: #c084fc;
    transform: translateY(-50%);
}

.child-icon {
    color: #0ea5e9;
}

.child-code {
    color: #0f172a;
    font-weight: 500;
    font-size: 0.9rem;
}

/* SKU Órfão Styles */
.orphan-sku-row {
    background: #ffffff;
    border-bottom: 1px solid #e5e7eb;
}

.orphan-sku-row:hover {
    background: #f9fafb;
}

.orphan-sku-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem;
}

.orphan-code {
    color: #374151;
    font-weight: 500;
}

/* Ícones de Hierarquia */
.hierarchy-icon {
    font-size: 1.2rem;
    flex-shrink: 0;
}

/* Badges */
.child-badge {
    background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
    color: #1e40af;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid #93c5fd;
}

.orphan-badge {
    background: linear-gradient(135deg, #f3f4f6 0%, #e5e7eb 100%);
    color: #374151;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
    border: 1px solid #d1d5db;
}

.section-title {
    font-size: 1.25rem;
    font-weight: 600;
    color: #111827;
    margin-bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
}

.item-count {
    font-size: 0.875rem;
    font-weight: 400;
    color: #6b7280;
    background: #f3f4f6;
    padding: 0.25rem 0.5rem;
    border-radius: 9999px;
}

.kit-row {
    background-color: #fefbff !important;
}

.kit-row:hover {
    background-color: #f3e8ff !important;
}

.sku-row:hover {
    background-color: #f9fafb;
}

.kit-status {
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
}

.kit-status.active {
    background-color: #dcfce7;
    color: #166534;
}

.kit-status.inactive {
    background-color: #fef2f2;
    color: #991b1b;
}

.kit-parent-badge {
    background-color: #ede9fe;
    color: #7c3aed;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-size: 0.75rem;
    font-weight: 500;
}

.no-parent {
    color: #6b7280;
    font-style: italic;
    font-size: 0.875rem;
}

.action-buttons {
    display: flex;
    gap: 0.5rem;
}

.kit-parent-form {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
}

.form-group {
    display: flex;
    flex-direction: column;
}

.form-group label {
    font-weight: 500;
    margin-bottom: 0.5rem;
    color: #374151;
}

.form-group input,
.form-group textarea {
    padding: 0.75rem;
    border: 1px solid #d1d5db;
    border-radius: 0.5rem;
    font-size: 0.875rem;
}

.form-group input:focus,
.form-group textarea:focus {
    outline: none;
    border-color: #2563eb;
    box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.checkbox-label {
    display: flex !important;
    flex-direction: row !important;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
}

.modal-actions {
    display: flex;
    gap: 1rem;
    justify-content: flex-end;
}

/* Kit row highlighting */
.kit-row {
    background-color: #faf5ff !important;
}

.kit-row:hover {
    background-color: #f3e8ff !important;
}

.kit-row td {
    position: relative;
}

.kit-row td:first-child::before {
    content: '📦';
    position: absolute;
    left: 5px;
    font-size: 12px;
}
</style>
