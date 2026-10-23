import { GraphQLError, GraphQLScalarType, Kind, type ValueNode } from 'graphql';

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function parseIso(value: string): Date {
  const date = new Date(value);
  if (!ISO_DATE_TIME.test(value) || Number.isNaN(date.getTime())) {
    throw new GraphQLError('DateTime must be an ISO 8601 string such as 2026-10-23T02:09:28.705Z');
  }
  return date;
}

// Resolver trả Date (hoặc chuỗi ISO), client nhận chuỗi ISO; ngược lại client gửi chuỗi ISO, resolver nhận Date.
export const DateTime = new GraphQLScalarType({
  name: 'DateTime',
  serialize(value) {
    const date = value instanceof Date ? value : typeof value === 'string' ? parseIso(value) : undefined;
    if (!date || Number.isNaN(date.getTime())) throw new GraphQLError('DateTime cannot represent an invalid date');
    return date.toISOString();
  },
  parseValue(value) {
    if (typeof value !== 'string') throw new GraphQLError('DateTime must be an ISO 8601 string');
    return parseIso(value);
  },
  parseLiteral(ast) {
    if (ast.kind !== Kind.STRING) throw new GraphQLError('DateTime must be an ISO 8601 string', { nodes: ast });
    return parseIso(ast.value);
  },
});

function literalToValue(ast: ValueNode, variables: Record<string, unknown> | null | undefined): unknown {
  switch (ast.kind) {
    case Kind.STRING:
    case Kind.BOOLEAN:
      return ast.value;
    case Kind.INT:
      return Number.parseInt(ast.value, 10);
    case Kind.FLOAT:
      return Number.parseFloat(ast.value);
    case Kind.NULL:
      return null;
    case Kind.ENUM:
      return ast.value;
    case Kind.LIST:
      return ast.values.map((item) => literalToValue(item, variables));
    case Kind.OBJECT:
      return Object.fromEntries(ast.fields.map((field) => [field.name.value, literalToValue(field.value, variables)]));
    case Kind.VARIABLE:
      return variables?.[ast.name.value];
  }
}

export const JSONScalar = new GraphQLScalarType({
  name: 'JSON',
  serialize: (value) => value,
  parseValue: (value) => value,
  parseLiteral: (ast, variables) => literalToValue(ast, variables),
});

export const scalarResolvers = { DateTime, JSON: JSONScalar };
