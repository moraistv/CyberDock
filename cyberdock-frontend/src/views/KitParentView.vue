<template>
    <div class="dashboard-wrapper">
        <SidebarComponent />
        <div class="main-content">
            <TopbarComponent />
            <div class="dashboard-content">
                <div class="header">
                    <div class="header-content">
                        <h1 class="dashboard-title">Gerenciar Kits Pai</h1>
                        <p class="dashboard-subtitle">Crie e organize kits pai para categorizar seus SKUs e produtos.</p>
                    </div>
                    <div class="header-actions">
                        <button @click="$router.go(-1)" class="btn btn-secondary">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="m15 18-6-6 6-6"/>
                            </svg>
                            Voltar
                        </button>
                        <button @click="openCreateModal" class="btn btn-primary">
                            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M12 5v14M5 12h14"/>
                            </svg>
                            Novo Kit Pai
                        </button>
                    </div>
                </div>

                <div v-if="isLoading" class="loading-state">
                    <div class="loading-spinner">
                        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin">
                            <path d="M21 12a9 9 0 11-6.219-8.56"/>
                        </svg>
                    </div>
                    <p>Carregando seus kits pai...</p>
                </div>

                <div v-else>
                    <!-- Stats Cards -->
                    <div class="stats-cards-grid">
                        <div class="stat-card">
                            <h3 class="card-title">Total de Kits Pai</h3>
                            <p class="metric-value">{{ kitParents.length }}</p>
                            <p class="card-description">Kits pai criados</p>
                        </div>
                        <div class="stat-card">
                            <h3 class="card-title">Kits Ativos</h3>
                            <p class="metric-value">{{ activeKitsCount }}</p>
                            <p class="card-description">Kits pai disponíveis para uso</p>
                        </div>
                        <div class="stat-card">
                            <h3 class="card-title">Kits Inativos</h3>
                            <p class="metric-value">{{ inactiveKitsCount }}</p>
                            <p class="card-description">Kits pai desativados</p>
                        </div>
                    </div>

                    <!-- Kits Grid -->
                    <div class="kits-container">
                        <div v-if="kitParents.length === 0" class="empty-state">
                            <div class="empty-icon">
                                <svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M7 16.5l-5 -3l5 -3l5 3v5.5l-5 3z"/>
                                    <path d="M2 13.5v5.5l5 3"/>
                                    <path d="M7 16.545l5 -3.03"/>
                                    <path d="M17 16.5l-5 -3l5 -3l5 3v5.5l-5 3z"/>
                                    <path d="M12 19l5 3"/>
                                    <path d="M17 16.5l5 -3"/>
                                    <path d="M12 13.5v-5.5l-5 -3l5 -3l5 3v5.5"/>
                                    <path d="M7 5.03v5.455"/>
                                    <path d="M12 8l5 -3"/>
                                </svg>
                            </div>
                            <h3>Nenhum kit pai criado ainda</h3>
                            <p>Crie seu primeiro kit pai para começar a organizar seus produtos.</p>
                            <button @click="openCreateModal" class="btn btn-primary">
                                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M12 5v14M5 12h14"/>
                                </svg>
                                Criar Primeiro Kit Pai
                            </button>
                        </div>

                        <div v-else class="kits-grid">
                            <div v-for="kit in kitParents" :key="kit.id" class="kit-card">
                                <div class="kit-card-header">
                                    <div class="kit-info">
                                        <h3 class="kit-name">{{ kit.nome }}</h3>
                                        <span class="kit-status" :class="kit.ativo ? 'active' : 'inactive'">
                                            {{ kit.ativo ? 'Ativo' : 'Inativo' }}
                                        </span>
                                    </div>
                                    <div class="kit-actions">
                                        <button @click="editKit(kit)" class="btn-icon" title="Editar">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <path d="M12 20h9"/>
                                                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                                            </svg>
                                        </button>
                                        <button @click="toggleKitStatus(kit)" class="btn-icon" :title="kit.ativo ? 'Desativar' : 'Ativar'">
                                            <svg v-if="kit.ativo" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <path d="M18 6L6 18M6 6l12 12"/>
                                            </svg>
                                            <svg v-else xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                                <polyline points="22,4 12,14.01 9,11.01"/>
                                            </svg>
                                        </button>
                                        <button @click="deleteKit(kit)" class="btn-icon delete" title="Excluir">
                                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <polyline points="3,6 5,6 21,6"/>
                                                <path d="M19,6v14a2,2 0 0,1-2,2H7a2,2 0 0,1-2-2V6m3,0V4a2,2 0 0,1,2-2h4a2,2 0 0,1,2,2v2"/>
                                                <line x1="10" y1="11" x2="10" y2="17"/>
                                                <line x1="14" y1="11" x2="14" y2="17"/>
                                            </svg>
                                        </button>
                                    </div>
                                </div>
                                <div class="kit-description">
                                    <p>{{ kit.descricao }}</p>
                                </div>
                                <div class="kit-footer">
                                    <small class="kit-date">
                                        Criado em {{ formatDate(kit.created_at) }}
                                    </small>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Kit Parent Form Modal -->
        <UniversalModal
            :title="isEditing ? 'Editar Kit Pai' : 'Criar Novo Kit Pai'"
            :is-open="isModalOpen"
            size="md"
            @close="closeModal"
        >
            <form @submit.prevent="handleSave" class="kit-form">
                <div class="form-group">
                    <label for="kit-name">Nome do Kit Pai</label>
                    <input 
                        id="kit-name" 
                        type="text" 
                        v-model="form.nome" 
                        required 
                        placeholder="Ex: Produtos de Beleza, Acessórios..."
                    >
                </div>
                
                <div class="form-group">
                    <label for="kit-description">Descrição</label>
                    <textarea 
                        id="kit-description" 
                        v-model="form.descricao" 
                        rows="4" 
                        required
                        placeholder="Descreva a finalidade deste kit pai..."
                    ></textarea>
                </div>
                
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" v-model="form.ativo">
                        <span class="checkmark"></span>
                        Kit ativo (disponível para uso)
                    </label>
                </div>
            </form>

            <template #footer>
                <div class="modal-actions">
                    <button @click="closeModal" type="button" class="btn btn-secondary" :disabled="isSaving">Cancelar</button>
                    <button @click="handleSave" type="button" class="btn btn-primary" :disabled="isSaving">
                        <svg v-if="isSaving" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin">
                            <path d="M21 12a9 9 0 11-6.219-8.56"/>
                        </svg>
                        <span v-if="!isSaving">{{ isEditing ? 'Atualizar' : 'Criar Kit Pai' }}</span>
                        <span v-else>{{ isEditing ? 'Atualizando...' : 'Criando...' }}</span>
                    </button>
                </div>
            </template>
        </UniversalModal>

        <!-- Delete Confirmation Modal -->
        <UniversalModal
            title="Confirmar Exclução"
            :is-open="isDeleteModalOpen"
            size="sm"
            @close="cancelDelete"
        >
            <div class="delete-confirmation">
                <div class="warning-icon">
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                    </svg>
                </div>
                <h3>Excluir Kit Pai</h3>
                <p v-if="kitToDelete">
                    Tem certeza que deseja excluir o kit pai "<strong>{{ kitToDelete.nome }}</strong>"?
                </p>
                <p class="warning-text">
                    Esta ação não pode ser desfeita.
                </p>
            </div>

            <template #footer>
                <div class="modal-actions">
                    <button @click="cancelDelete" type="button" class="btn btn-secondary" :disabled="isDeletingKit">Cancelar</button>
                    <button @click="confirmDelete" type="button" class="btn btn-danger" :disabled="isDeletingKit">
                        <svg v-if="isDeletingKit" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin">
                            <path d="M21 12a9 9 0 11-6.219-8.56"/>
                        </svg>
                        <span v-if="!isDeletingKit">Excluir Kit Pai</span>
                        <span v-else>Excluindo...</span>
                    </button>
                </div>
            </template>
        </UniversalModal>
    </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import SidebarComponent from '../components/SidebarComponent.vue';
import TopbarComponent from '../components/TopbarComponent.vue';
import UniversalModal from '../components/UniversalModal.vue';
import { useAuth } from '@/composables/useAuth';
import { useKitParent } from '@/composables/useKitParent';

const { user } = useAuth();
const userId = computed(() => user.value?.uid);

const {
    kitParents,
    isLoading,
    createKitParent,
    updateKitParent,
    toggleKitParentStatus,
    deleteKitParent: deleteKitParentComposable
} = useKitParent(userId);

// Modal states
const isModalOpen = ref(false);
const isEditing = ref(false);
const currentKit = ref(null);
const isDeleteModalOpen = ref(false);
const kitToDelete = ref(null);
const isSaving = ref(false); // Estado de loading para salvamento
const isDeletingKit = ref(false); // Estado de loading para exclusão
const isTogglingStatus = ref(false); // Estado de loading para toggle de status

// Form data
const form = ref({
    nome: '',
    descricao: '',
    ativo: true
});

// Computed properties
const activeKitsCount = computed(() => {
    return kitParents.value.filter(kit => kit.ativo).length;
});

const inactiveKitsCount = computed(() => {
    return kitParents.value.filter(kit => !kit.ativo).length;
});

// Methods
const openCreateModal = () => {
    console.log('💫 [DEBUG] Abrindo modal de criação de kit');
    resetForm();
    isEditing.value = false;
    currentKit.value = null;
    isModalOpen.value = true;
    console.log('🔍 [DEBUG] Modal aberto - isModalOpen:', isModalOpen.value);
    console.log('🔍 [DEBUG] Form resetado:', form.value);
};

const editKit = (kit) => {
    console.log('✏️ [DEBUG] Editando kit:', kit);
    form.value = { 
        nome: kit.nome,
        descricao: kit.descricao,
        ativo: kit.ativo
    };
    currentKit.value = kit;
    isEditing.value = true;
    isModalOpen.value = true;
    console.log('🔍 [DEBUG] Form preenchido para edição:', form.value);
};

const closeModal = () => {
    console.log('💫 [DEBUG] Fechando modal');
    isModalOpen.value = false;
    isEditing.value = false;
    currentKit.value = null;
    resetForm();
};

const resetForm = () => {
    form.value = {
        nome: '',
        descricao: '',
        ativo: true
    };
    console.log('🔄 [DEBUG] Form resetado:', form.value);
};

const handleSave = async () => {
    console.log('🚀 [DEBUG] Iniciando handleSave');
    console.log('📝 [DEBUG] Dados do form:', form.value);
    console.log('🔍 [DEBUG] isEditing:', isEditing.value);
    
    // Validação básica no frontend
    if (!form.value.nome || !form.value.nome.trim()) {
        console.warn('⚠️ [DEBUG] Validação falhou: Nome vazio');
        showToast('Nome do kit pai é obrigatório', 'error');
        return;
    }
    
    if (!form.value.descricao || !form.value.descricao.trim()) {
        console.warn('⚠️ [DEBUG] Validação falhou: Descrição vazia');
        showToast('Descrição do kit pai é obrigatória', 'error');
        return;
    }
    
    console.log('✅ [DEBUG] Validações passaram, enviando dados');
    
    isSaving.value = true; // Ativar loading
    
    try {
        console.log('📦 [DEBUG] Enviando dados do kit pai:', form.value);
        console.log('🔑 [DEBUG] userId atual:', userId.value);
        
        if (isEditing.value) {
            console.log('✏️ [DEBUG] Editando kit pai ID:', currentKit.value.id);
            const result = await updateKitParent(currentKit.value.id, form.value);
            console.log('✅ [DEBUG] Kit pai atualizado:', result);
            showToast('Kit pai atualizado com sucesso!', 'success');
        } else {
            console.log('➕ [DEBUG] Criando novo kit pai');
            console.log('🔍 [DEBUG] Verificando se createKitParent existe:', typeof createKitParent);
            
            const result = await createKitParent(form.value);
            console.log('🎉 [DEBUG] Kit pai criado com sucesso:', result);
            showToast('Kit pai criado com sucesso!', 'success');
        }
        
        console.log('💫 [DEBUG] Fechando modal');
        closeModal();
    } catch (error) {
        console.error('💥 [DEBUG] Erro completo ao salvar kit pai:');
        console.error('💥 [DEBUG] Tipo:', typeof error);
        console.error('💥 [DEBUG] Mensagem:', error.message);
        console.error('💥 [DEBUG] Stack:', error.stack);
        console.error('💥 [DEBUG] Objeto completo:', error);
        
        const errorMessage = error.message || 'Erro desconhecido ao salvar kit pai';
        console.error('🚨 [DEBUG] Exibindo toast com erro:', errorMessage);
        showToast(errorMessage, 'error');
    } finally {
        isSaving.value = false; // Desativar loading
    }
};

const toggleKitStatus = async (kit) => {
    isTogglingStatus.value = true;
    try {
        await toggleKitParentStatus(kit.id);
        showToast(`Kit pai ${kit.ativo ? 'desativado' : 'ativado'} com sucesso!`, 'success');
    } catch (error) {
        showToast(error.message || 'Erro ao alterar status do kit pai', 'error');
    } finally {
        isTogglingStatus.value = false;
    }
};

const deleteKit = async (kit) => {
    kitToDelete.value = kit;
    isDeleteModalOpen.value = true;
};

const confirmDelete = async () => {
    if (kitToDelete.value) {
        isDeletingKit.value = true;
        try {
            await deleteKitParentComposable(kitToDelete.value.id);
            showToast('Kit pai excluído com sucesso!', 'success');
        } catch (error) {
            showToast(error.message || 'Erro ao deletar kit pai', 'error');
        } finally {
            isDeletingKit.value = false;
        }
    }
    isDeleteModalOpen.value = false;
    kitToDelete.value = null;
};

const cancelDelete = () => {
    isDeleteModalOpen.value = false;
    kitToDelete.value = null;
};

const formatDate = (dateString) => {
    return new Date(dateString).toLocaleDateString('pt-BR');
};

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
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

.dashboard-wrapper { 
    display: flex; 
    min-height: 100vh; 
    font-family: 'Inter', sans-serif; 
    background-color: #f3f4f6; 
}

.main-content { 
    flex: 1; 
    display: flex; 
    flex-direction: column; 
}

.dashboard-content { 
    flex: 1; 
    padding: 2rem; 
}

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

.dashboard-title { 
    font-size: 1.875rem; 
    font-weight: 700; 
    color: #111827; 
    margin: 0;
}

.dashboard-subtitle { 
    margin-top: 0.25rem; 
    font-size: 0.875rem; 
    color: #6b7280; 
}

.loading-state { 
    text-align: center; 
    padding: 4rem; 
    color: #6b7280; 
}

.loading-spinner {
    margin-bottom: 1rem;
}

.animate-spin {
    animation: spin 1s linear infinite;
}

@keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
}

/* Stats Cards */
.stats-cards-grid { 
    display: grid; 
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); 
    gap: 1rem; 
    margin-bottom: 2rem; 
}

.stat-card { 
    background-color: #ffffff; 
    border-radius: 0.75rem; 
    padding: 1.25rem; 
    border: 1px solid #e5e7eb; 
    display: flex; 
    flex-direction: column; 
}

.card-title { 
    font-size: 0.875rem; 
    font-weight: 600; 
    color: #374151; 
    margin: 0 0 0.75rem 0; 
}

.metric-value { 
    font-size: 1.875rem; 
    font-weight: 700; 
    color: #111827; 
    line-height: 1.2; 
    margin: 0;
}

.card-description { 
    font-size: 0.75rem; 
    color: #6b7280; 
    margin: 0.25rem 0 0 0; 
}

/* Kits Container */
.kits-container {
    background-color: #ffffff;
    border-radius: 0.75rem;
    box-shadow: 0 1px 3px 0 rgba(0, 0, 0, 0.1);
    padding: 1.5rem;
}

.empty-state {
    text-align: center;
    padding: 4rem 2rem;
}

.empty-icon {
    margin-bottom: 1.5rem;
    color: #d1d5db;
}

.empty-state h3 {
    font-size: 1.25rem;
    font-weight: 600;
    color: #374151;
    margin: 0 0 0.5rem 0;
}

.empty-state p {
    color: #6b7280;
    margin: 0 0 2rem 0;
}

.kits-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 1.5rem;
}

.kit-card {
    background-color: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.75rem;
    padding: 1.25rem;
    transition: all 0.2s ease;
}

.kit-card:hover {
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
    transform: translateY(-2px);
}

.kit-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
}

.kit-info {
    flex: 1;
}

.kit-name {
    font-size: 1.125rem;
    font-weight: 600;
    color: #111827;
    margin: 0 0 0.5rem 0;
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

.kit-actions {
    display: flex;
    gap: 0.5rem;
}

.kit-description {
    margin-bottom: 1rem;
}

.kit-description p {
    color: #6b7280;
    font-size: 0.875rem;
    line-height: 1.5;
    margin: 0;
}

.kit-footer {
    border-top: 1px solid #e5e7eb;
    padding-top: 0.75rem;
}

.kit-date {
    color: #9ca3af;
    font-size: 0.75rem;
}

/* Buttons */
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
    position: relative;
}

.btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    transform: none !important;
}

.btn:disabled:hover {
    transform: none !important;
    box-shadow: none !important;
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

.btn-primary:disabled {
    background-color: #93c5fd;
}

.btn-primary:disabled:hover {
    background-color: #93c5fd;
}

.btn-secondary {
    background-color: #6b7280;
    color: white;
}

.btn-secondary:hover {
    background-color: #4b5563;
}

.btn-danger {
    background-color: #dc2626;
    color: white;
}

.btn-danger:hover {
    background-color: #b91c1c;
}

.btn-danger:disabled {
    background-color: #fca5a5;
}

.btn-danger:disabled:hover {
    background-color: #fca5a5;
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

.btn-icon:hover {
    transform: scale(1.05);
}

.btn-icon.delete {
    background-color: #fef2f2;
    color: #dc2626;
}

/* Form Styles */
.kit-form {
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

/* Delete Confirmation Modal */
.delete-confirmation {
    text-align: center;
    padding: 1rem 0;
}

.warning-icon {
    margin-bottom: 1rem;
}

.delete-confirmation h3 {
    margin: 0 0 1rem 0;
    color: #374151;
    font-size: 1.25rem;
    font-weight: 600;
}

.delete-confirmation p {
    margin: 0 0 0.75rem 0;
    color: #6b7280;
    line-height: 1.5;
}

.warning-text {
    color: #dc2626 !important;
    font-weight: 500;
    font-size: 0.875rem;
}

/* Responsive */
@media (max-width: 768px) {
    .header {
        flex-direction: column;
        align-items: stretch;
        gap: 1rem;
    }
    
    .header-actions {
        justify-content: stretch;
    }
    
    .btn {
        flex: 1;
        justify-content: center;
    }
    
    .kits-grid {
        grid-template-columns: 1fr;
    }
    
    .kit-card-header {
        flex-direction: column;
        align-items: stretch;
        gap: 1rem;
    }
    
    .kit-actions {
        align-self: center;
    }
}
</style>