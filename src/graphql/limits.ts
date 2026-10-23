import { GraphQLError, Kind, type OperationDefinitionNode, type SelectionSetNode, type ValidationRule } from 'graphql';

export interface Limits {
  maxDepth: number; // số tầng trường lồng nhau
  maxFields: number; // tổng số trường sau khi mở fragment
  maxRootFields: number; // số trường ở gốc (alias nhân bản một thao tác tốn kém thường nằm ở đây)
}

export const defaultLimits: Limits = { maxDepth: 8, maxFields: 100, maxRootFields: 10 };

// Chỉ miễn khi TOÀN BỘ trường gốc là của introspection; một trường __type đứng cạnh các alias thường không được miễn.
const INTROSPECTION_FIELDS = new Set(['__schema', '__type', '__typename']);
const isIntrospection = (operation: OperationDefinitionNode): boolean =>
  operation.selectionSet.selections.every((s) => s.kind === Kind.FIELD && INTROSPECTION_FIELDS.has(s.name.value));

// Chạy trước khi thực thi. Đi theo cả fragment (không thì giấu được 20 tầng trong một fragment) và dừng ngay khi vượt
// giới hạn (không thì "bom fragment" mở rộng theo cấp số nhân). Truy vấn introspection được miễn: nó sâu hơn giới
// hạn thường ngày, còn việc cho phép nó hay không do cờ introspection của Apollo quyết định.
export const limitsRule =
  (limits: Limits): ValidationRule =>
  (context) => ({
    OperationDefinition(operation) {
      if (isIntrospection(operation)) return;

      let fields = 0;
      let rootFields = 0;
      let violation: string | undefined;

      const visit = (selectionSet: SelectionSetNode, depth: number, spreading: Set<string>): void => {
        for (const selection of selectionSet.selections) {
          if (violation) return;
          if (selection.kind === Kind.FIELD) {
            fields += 1;
            if (depth === 1) rootFields += 1;
            if (depth > limits.maxDepth) violation = `Query is too deep (more than ${limits.maxDepth} levels)`;
            else if (rootFields > limits.maxRootFields) violation = `Too many top-level fields (more than ${limits.maxRootFields})`;
            else if (fields > limits.maxFields) violation = `Query selects too many fields (more than ${limits.maxFields})`;
            else if (selection.selectionSet) visit(selection.selectionSet, depth + 1, spreading);
          } else if (selection.kind === Kind.INLINE_FRAGMENT) {
            visit(selection.selectionSet, depth, spreading);
          } else {
            const name = selection.name.value;
            const fragment = context.getFragment(name);
            if (!fragment || spreading.has(name)) continue; // vòng lặp fragment do rule NoFragmentCycles báo
            spreading.add(name);
            visit(fragment.selectionSet, depth, spreading);
            spreading.delete(name);
          }
        }
      };

      visit(operation.selectionSet, 1, new Set());
      if (violation) context.reportError(new GraphQLError(violation, { nodes: operation }));
    },
  });
