# Mapeamento de Cenários de Etiquetas - CYBER DOCK

## Resumo das Melhorias Implementadas

### 🎯 Objetivo
Mapear e resolver cenários específicos onde etiquetas deveriam estar disponíveis para impressão mas não estavam aparecendo no sistema.

### 🔧 Ferramentas de Debug Criadas

#### 1. **Botão de Debug Individual**
- **Localização**: Coluna "Etiquetas" de cada venda
- **Função**: `debugLabelAvailability(sale)`
- **O que faz**: Analisa detalhadamente uma venda específica e exibe no console:
  - Informações básicas da venda
  - Status da venda e expedição
  - Verificações passo a passo
  - Status final da etiqueta
  - Cenário específico identificado

#### 2. **Botão de Mapeamento Completo**
- **Localização**: Painel de ações da tabela
- **Função**: `mapAllLabelScenarios()`
- **O que faz**: Analisa todas as vendas da página atual e categoriza por cenário:
  - Vendas não processadas
  - Data limite não atingida
  - Status da venda impede impressão
  - Dados básicos inválidos
  - Etiquetas não verificadas
  - Etiquetas disponíveis
  - Erros de API

### 📊 Cenários Mapeados

#### **CENÁRIO 1: Vendas Não Processadas**
- **Condição**: `!sale.processed_at`
- **Motivo**: Venda precisa ser processada antes de imprimir etiqueta
- **Solução**: Processar a venda primeiro usando o botão "Processar Vendas"

#### **CENÁRIO 2: Data Limite Não Atingida**
- **Condição**: Data limite de envio é futura
- **Motivo**: Etiqueta só fica disponível no dia do despacho
- **Solução**: Aguardar até a data limite de envio

#### **CENÁRIO 3: Status da Venda Impede Impressão**
- **Condição**: Status da venda é `cancelled`, `canceled`, `shipped`, `delivered`
- **Motivo**: Venda cancelada, já enviada ou entregue
- **Solução**: Verificar se o status está correto

#### **CENÁRIO 4: Dados Básicos Inválidos**
- **Condição**: Falta `shipmentId` ou `sellerId`
- **Motivo**: Dados necessários para baixar etiqueta não encontrados
- **Solução**: Verificar se a venda tem dados completos do ML

#### **CENÁRIO 5: Etiquetas Não Verificadas**
- **Condição**: Passou em todas as verificações mas não foi verificado na API
- **Motivo**: Ainda não foi feita verificação em tempo real
- **Solução**: Usar botão "Verificar" para checar na API

#### **CENÁRIO 6: Etiquetas Disponíveis**
- **Condição**: Todos os critérios atendidos
- **Motivo**: Etiqueta pronta para download
- **Solução**: Usar botões PDF/ZPL para baixar

#### **CENÁRIO 7: Erros de API**
- **Condição**: API retornou erro na verificação
- **Motivo**: Problema de conectividade ou token expirado
- **Solução**: Verificar conexão e tentar novamente

#### **CENÁRIO 8: Problemas de Timezone** ⭐ NOVO
- **Condição**: Data limite é hoje mas etiqueta não aparece
- **Motivo**: Diferença de timezone entre servidor e cliente
- **Solução**: Usar botão "Forçar Verificação" ou aguardar algumas horas

#### **CENÁRIO 9: Status Desconhecidos** ⭐ NOVO
- **Condição**: Status da venda não está nas listas conhecidas
- **Motivo**: Novos status do ML ou dados incompletos
- **Solução**: Sistema agora permite tentar verificar na API

#### **CENÁRIO 10: Cache Desatualizado** ⭐ NOVO
- **Condição**: Etiqueta deveria estar disponível mas cache está antigo
- **Motivo**: Cache não foi atualizado após mudanças de status
- **Solução**: Usar botão "Forçar Verificação" para limpar cache

### 🚀 Melhorias na Lógica

#### **Verificação Mais Robusta**
- Adicionada verificação de processamento da venda
- Melhor tratamento de status da venda
- Informações de debug mais detalhadas
- Categorização automática de cenários
- **NOVO**: Verificação de data mais tolerante com timezone
- **NOVO**: Suporte a múltiplos formatos de data
- **NOVO**: Margem de tolerância de 1 dia para casos de timezone

#### **Status Mais Permissivos**
- **NOVO**: Lista expandida de status que permitem etiquetas
- **NOVO**: Status desconhecidos não bloqueiam mais automaticamente
- **NOVO**: Lógica mais otimista - deixa o backend decidir

#### **Interface Melhorada**
- Botão de debug individual para cada venda
- Botão de mapeamento completo de cenários
- **NOVO**: Botão de forçar verificação (ignora cache)
- Indicadores visuais mais informativos
- Tooltips com informações detalhadas

#### **Debug Avançado**
- Logs estruturados no console
- Identificação automática de cenários
- Informações técnicas detalhadas
- Relatórios de mapeamento
- **NOVO**: Função para limpar cache
- **NOVO**: Verificação forçada ignorando cache

### 📝 Como Usar

1. **Para debug individual**: Clique no botão "Debug" na coluna de etiquetas de qualquer venda
2. **Para mapeamento completo**: Clique no botão "Mapear Cenários" no painel de ações
3. **Para verificar etiquetas**: Use o botão "Verificar Etiquetas" para checar todas as disponíveis
4. **Verificação automática**: As etiquetas são verificadas automaticamente em tempo real
5. **Para processar vendas**: Use o botão "Processar Vendas" para processar vendas pendentes

### 🔧 Soluções para Cenários Específicos

#### **Quando a etiqueta deveria estar disponível mas não está:**
1. **Primeiro**: Use o botão "Debug" na venda específica para ver o motivo
2. **Se for problema de data**: Aguarde algumas horas - a verificação é automática
3. **Se for problema de cache**: A verificação em tempo real resolve automaticamente
4. **Se for status desconhecido**: O sistema agora permite tentar verificar na API
5. **Se nada funcionar**: Verifique se a venda foi processada e se tem dados completos do ML

### 🎯 Próximos Passos

1. **Testar os cenários** identificados com dados reais
2. **Validar** se todos os casos estão sendo mapeados corretamente
3. **Ajustar** a lógica conforme necessário baseado nos resultados
4. **Documentar** casos específicos que precisam de atenção especial

### 💡 Benefícios

- **Transparência**: Agora é possível ver exatamente por que uma etiqueta não está disponível
- **Debugging**: Ferramentas para identificar e resolver problemas rapidamente
- **Mapeamento**: Visão completa de todos os cenários na página atual
- **Melhoria Contínua**: Base sólida para identificar e resolver novos cenários

---

**Desenvolvido por**: Gustavo Maldanis  
**Data**: 3 de setembro de 2024  
**Versão**: 1.0
