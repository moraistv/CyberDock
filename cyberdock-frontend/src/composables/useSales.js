import { ref } from 'vue';
import { useApi } from './useApi'; 

export function useSales() {
  const sales = ref([]);
  const isLoading = ref(false);
  const error = ref(null);
  const api = useApi(); 

  const fetchSales = async () => {
    isLoading.value = true;
    error.value = null;
    try {
      const salesData = await api.get('/sales/my-sales');
      sales.value = salesData;
    } catch (err) {
      console.error("Erro ao buscar vendas:", err);
      error.value = "Não foi possível carregar a lista de vendas.";
    } finally {
      isLoading.value = false;
    }
  };

  return {
    sales,
    isLoading,
    error,
    fetchSales,
  };
}