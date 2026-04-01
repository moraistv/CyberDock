// composables/useServices.js
import { ref } from 'vue';
import { useApi } from './useApi';

/**
 * Composable para gerenciar o catálogo de serviços/produtos e os serviços contratados pelos clientes.
 */
export function useServices() {
    const api = useApi();
    
    // --- Estado do Catálogo de Serviços ---
    const services = ref([]);
    const isLoadingServices = ref(true);
    const serviceCatalogueError = ref(null);

    // --- Estado para Modais do Catálogo ---
    const isServiceModalOpen = ref(false);
    const isDeleteServiceModalOpen = ref(false);
    const isEditingService = ref(false);
    const currentService = ref(null);
    const serviceToDelete = ref(null);

    // --- Estado para Serviços Contratados do Cliente ---
    const clientServices = ref([]);
    const isLoadingClientServices = ref(false);
    const clientServicesError = ref(null);

    /**
     * Busca o catálogo de serviços/produtos do backend.
     */
    async function fetchServices() {
        isLoadingServices.value = true;
        serviceCatalogueError.value = null;
        try {
            const data = await api.get('/services');
            services.value = data;
        } catch (err) {
            console.error("Erro ao carregar serviços:", err);
            serviceCatalogueError.value = err.message || "Não foi possível carregar o catálogo de serviços.";
        } finally {
            isLoadingServices.value = false;
        }
    }

    /**
     * Adiciona ou atualiza um serviço/produto no catálogo.
     */
    async function handleSaveService() {
        if (!currentService.value || !currentService.value.name || currentService.value.price == null) {
            console.error("Nome e preço são obrigatórios.");
            return;
        }

        try {
            if (isEditingService.value) {
                await api.put(`/services/${currentService.value.id}`, currentService.value);
            } else {
                await api.post('/services', currentService.value);
            }
            
            await fetchServices(); // Recarrega a lista
            closeServiceModal();

        } catch (err) {
            console.error("Erro ao salvar serviço:", err);
            alert(err.message || "Falha ao salvar o item.");
        }
    }

    /**
     * Exclui um serviço/produto do catálogo.
     */
    async function handleConfirmDeleteService() {
        if (!serviceToDelete.value) return;

        try {
            await api.delete(`/services/${serviceToDelete.value.id}`);
            await fetchServices(); // Recarrega a lista
            closeDeleteServiceModal();
        } catch (err) {
            console.error("Erro ao excluir serviço:", err);
            alert(err.message || "Falha ao excluir o item.");
        }
    }

    /**
     * Busca os serviços contratados por um cliente específico.
     * @param {string} uid - O UID do usuário
     */
    async function fetchClientServices(uid) {
        isLoadingClientServices.value = true;
        clientServicesError.value = null;
        try {
            const data = await api.get(`/users/contracts/${uid}`);
            clientServices.value = data.contracts || [];
        } catch (err) {
            console.error("Erro ao carregar serviços do cliente:", err);
            clientServicesError.value = err.message || "Não foi possível carregar os serviços do cliente.";
            clientServices.value = [];
        } finally {
            isLoadingClientServices.value = false;
        }
    }

    /**
     * Adiciona um novo serviço contratado para o cliente.
     * @param {string} uid - O UID do usuário
     * @param {object} contractData - Dados do contrato a ser adicionado
     */
    async function addClientService(uid, contractData) {
        try {
            await api.post(`/users/contracts/${uid}`, contractData);
            await fetchClientServices(uid); // Recarrega a lista do cliente
        } catch (err) {
            console.error("Erro ao adicionar serviço ao cliente:", err);
            alert(err.message || "Falha ao adicionar serviço.");
        }
    }

    /**
     * Remove um serviço contratado do cliente.
     * @param {string} uid - O UID do usuário
     * @param {number} contractId - ID do contrato a ser removido
     */
    async function removeClientService(uid, contractId) {
        try {
            await api.delete(`/users/contracts/${uid}/${contractId}`);
            await fetchClientServices(uid); // Recarrega a lista do cliente
        } catch (err) {
            console.error("Erro ao remover serviço do cliente:", err);
            alert(err.message || "Falha ao remover serviço.");
        }
    }

    // --- Funções do Modal do Catálogo ---
    const openServiceModal = (service = null) => {
        isEditingService.value = !!service;
        currentService.value = service ? { ...service } : { name: '', price: 0, description: '' };
        isServiceModalOpen.value = true;
    };
    const closeServiceModal = () => {
        isServiceModalOpen.value = false;
        currentService.value = null;
    };

    // Funções do Modal de Deleção do Catálogo
    const openDeleteServiceModal = (service) => {
        serviceToDelete.value = service;
        isDeleteServiceModalOpen.value = true;
    };
    const closeDeleteServiceModal = () => {
        isDeleteServiceModalOpen.value = false;
        serviceToDelete.value = null;
    };

    const formatCurrency = (value) => {
        if (typeof value !== 'number') return 'R$ 0,00';
        return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    };
    
    return {
        // Catálogo de Serviços
        services,
        isLoadingServices,
        serviceCatalogueError,
        isEditingService,
        currentService,
        isServiceModalOpen,
        isDeleteServiceModalOpen,
        serviceToDelete,
        openServiceModal,
        closeServiceModal,
        handleSaveService,
        openDeleteServiceModal,
        closeDeleteServiceModal,
        handleConfirmDeleteService,
        fetchServices,

        // Serviços do Cliente
        clientServices,
        isLoadingClientServices,
        clientServicesError,
        fetchClientServices,
        addClientService,
        removeClientService,

        // Utilitários
        formatCurrency,
    };
}
