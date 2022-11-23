'use strict'

const camelcase = require('camelcase')
const { singularize } = require('inflected')
const {
  toSingular,
  tableName,
  sanitizeLimit
} = require('./utils')

function createMapper (defaultDb, sql, log, table, fields, primaryKey, relations, queries, autoTimestamp, schema, limitConfig) {
  const entityName = toSingular(table)

  // Fields remapping
  const fieldMapToRetrieve = {}
  const inputToFieldMap = {}
  const camelCasedFields = Object.keys(fields).reduce((acc, key) => {
    const camel = camelcase(key)
    acc[camel] = fields[key]
    fieldMapToRetrieve[key] = camel
    inputToFieldMap[camel] = key
    fields[key].camelcase = camel
    return acc
  }, {})

  function fixInput (input) {
    const newInput = {}
    for (const key of Object.keys(input)) {
      const value = input[key]
      let newKey = inputToFieldMap[key]
      if (newKey === undefined) {
        if (fields[key] !== undefined) {
          newKey = key
        } else {
          throw new Error(`Unknown field ${key}`)
        }
      }
      newInput[newKey] = value
    }
    return newInput
  }

  function fixOutput (output) {
    if (!output) {
      return output
    }
    const newOutput = {}
    for (const key of Object.keys(output)) {
      let value = output[key]
      const newKey = fieldMapToRetrieve[key]
      if (key === primaryKey && value !== null && value !== undefined) {
        value = value.toString()
      }
      newOutput[newKey] = value
    }
    return newOutput
  }

  async function save (args) {
    const db = args.tx || defaultDb
    if (args.input === undefined) {
      throw new Error('Input not provided.')
    }
    // args.input is not array
    const fieldsToRetrieve = computeFields(args.fields).map((f) => sql.ident(f))
    const input = fixInput(args.input)
    let now
    if (autoTimestamp && fields.updated_at) {
      now = new Date()
      input.updated_at = now
    }
    if (input[primaryKey]) { // update
      const res = await queries.updateOne(db, sql, table, schema, input, primaryKey, fieldsToRetrieve)
      return fixOutput(res)
    } else { // insert
      if (autoTimestamp && fields.inserted_at) {
        /* istanbul ignore next */
        now = now || new Date()
        input.inserted_at = now
      }
      const res = await queries.insertOne(db, sql, table, schema, input, primaryKey, fields[primaryKey].sqlType.toLowerCase() === 'uuid', fieldsToRetrieve)
      return fixOutput(res)
    }
  }

  async function insert (args) {
    const db = args.tx || defaultDb
    const fieldsToRetrieve = computeFields(args.fields).map((f) => sql.ident(f))
    const inputs = args.inputs
    // This else is skipped on MySQL because of https://github.com/ForbesLindesay/atdatabases/issues/221
    /* istanbul ignore else */
    if (autoTimestamp) {
      const now = new Date()
      for (const input of inputs) {
        if (fields.inserted_at) {
          input.insertedAt = now
        }
        if (fields.updated_at) {
          input.updatedAt = now
        }
      }
    }
    /* istanbul ignore next */
    if (queries.insertMany) {
      // We are not fixing the input here because it is done in the query.
      const res = await queries.insertMany(db, sql, table, schema, inputs, inputToFieldMap, primaryKey, fieldsToRetrieve, fields)
      return res.map(fixOutput)
    } else {
      // TODO this can be optimized, we can still use a batch insert if we do not want any fields
      const res = []
      for (let input of inputs) {
        input = fixInput(input)
        const resOne = await queries.insertOne(db, sql, table, schema, input, primaryKey, fields[primaryKey].sqlType.toLowerCase() === 'uuid', fieldsToRetrieve)
        res.push(fixOutput(resOne))
      }

      return res
    }
  }

  async function updateMany (args) {
    const db = args.tx || defaultDb
    const fieldsToRetrieve = computeFields(args.fields).map((f) => sql.ident(f))
    if (args.input === undefined) {
      throw new Error('Input not provided.')
    }
    const input = fixInput(args.input)
    let now
    if (autoTimestamp && fields.updated_at) {
      now = new Date()
      input.updated_at = now
    }
    const criteria = computeCriteria(args)

    const res = await queries.updateMany(db, sql, table, schema, criteria, input, fieldsToRetrieve)
    return res.map(fixOutput)
  }

  function computeFields (fields) {
    if (!fields) {
      return Object.values(inputToFieldMap)
    }

    /**
     * The 'field' can be a relational field which is undefined
     * in the inputToFieldMap
     * @see sql-graphql
    */
    const requestedFields = fields.map((field) => {
      if (relations.some((relation) => field === relation.column_name)) {
        return field
      }
      return inputToFieldMap[field]
    })

    const set = new Set(requestedFields)
    set.delete(undefined)
    const fieldsToRetrieve = [...set]
    return fieldsToRetrieve
  }

  const whereMap = {
    eq: '=',
    in: 'IN',
    nin: 'NOT IN',
    neq: '<>',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    like: 'LIKE'
  }

  function computeCriteria (opts) {
    const where = opts.where || {}
    const criteria = []
    for (const key of Object.keys(where)) {
      const value = where[key]
      const field = inputToFieldMap[key]
      for (const key of Object.keys(value)) {
        const operator = whereMap[key]
        /* istanbul ignore next */
        if (!operator) {
          // This should never happen
          throw new Error(`Unsupported where clause ${JSON.stringify(where[key])}`)
        }
        const fieldWrap = fields[field]
        if (operator === '=' && value[key] === null) {
          criteria.push(sql`${sql.ident(field)} IS NULL`)
        } else if (operator === '<>' && value[key] === null) {
          criteria.push(sql`${sql.ident(field)} IS NOT NULL`)
        } else if (operator === 'LIKE') {
          let leftHand = sql.ident(field)
          // NOTE: cast fields AS CHAR(64) and TRIM the whitespaces
          // to prevent errors with fields different than VARCHAR & TEXT
          if (!['text', 'varchar'].includes(fieldWrap.sqlType)) {
            leftHand = sql`TRIM(CAST(${sql.ident(field)} AS CHAR(64)))`
          }
          criteria.push(sql`${leftHand} LIKE ${value[key]}`)
        } else {
          criteria.push(sql`${sql.ident(field)} ${sql.__dangerous__rawValue(operator)} ${computeCriteriaValue(fieldWrap, value[key])}`)
        }
      }
    }
    return criteria
  }

  function computeCriteriaValue (fieldWrap, value) {
    if (Array.isArray(value)) {
      return sql`(${sql.join(
        value.map((v) => computeCriteriaValue(fieldWrap, v)),
        sql`, `
      )})`
    }

    /* istanbul ignore next */
    if (fieldWrap.sqlType === 'int4' || fieldWrap.sqlType === 'int2' || fieldWrap.sqlType === 'float8' || fieldWrap.sqlType === 'float4') {
      // This cat is needed in PostgreSQL
      return sql`${Number(value)}`
    } else {
      return sql`${value}`
    }
  }

  async function find (opts = {}) {
    const db = opts.tx || defaultDb
    const fieldsToRetrieve = computeFields(opts.fields).map((f) => sql.ident(f))
    const criteria = computeCriteria(opts)

    let query = sql`
      SELECT ${sql.join(fieldsToRetrieve, sql`, `)}
      FROM ${tableName(sql, table, schema)}
    `

    if (criteria.length > 0) {
      query = sql`${query} WHERE ${sql.join(criteria, sql` AND `)}`
    }

    if (opts.orderBy && opts.orderBy.length > 0) {
      const orderBy = opts.orderBy.map((order) => {
        const field = inputToFieldMap[order.field]
        return sql`${sql.ident(field)} ${sql.__dangerous__rawValue(order.direction)}`
      })
      query = sql`${query} ORDER BY ${sql.join(orderBy, sql`, `)}`
    }

    query = sql`${query} LIMIT ${sanitizeLimit(opts.limit, limitConfig)}`
    if (opts.offset !== undefined) {
      if (opts.offset < 0) {
        throw new Error(`Param offset=${opts.offset} not allowed. It must be not negative value.`)
      }
      query = sql`${query} OFFSET ${opts.offset}`
    }

    const res = await db.query(query)
    return res.map(fixOutput)
  }

  async function count (opts = {}) {
    const db = opts.tx || defaultDb
    let totalCountQuery = null
    totalCountQuery = sql`
        SELECT COUNT(*) AS total 
        FROM ${tableName(sql, table, schema)}
      `
    const criteria = computeCriteria(opts)
    if (criteria.length > 0) {
      totalCountQuery = sql`${totalCountQuery} WHERE ${sql.join(criteria, sql` AND `)}`
    }
    const [{ total }] = await db.query(totalCountQuery)
    return +total
  }

  async function _delete (opts) {
    const db = opts.tx || defaultDb
    const fieldsToRetrieve = computeFields(opts.fields).map((f) => sql.ident(f))
    const criteria = computeCriteria(opts)
    const res = await queries.deleteAll(db, sql, table, schema, criteria, fieldsToRetrieve)
    return res.map(fixOutput)
  }

  return {
    name: entityName,
    singularName: camelcase(singularize(table)),
    pluralName: camelcase(table),
    primaryKey,
    table,
    schema,
    fields,
    camelCasedFields,
    fixInput,
    fixOutput,
    find,
    count,
    insert,
    save,
    delete: _delete,
    updateMany
  }
}

async function buildEntity (db, sql, log, table, queries, autoTimestamp, schema, ignore, limitConfig) {
  // Compute the columns
  const columns = (await queries.listColumns(db, sql, table, schema)).filter((c) => !ignore[c.column_name])
  const fields = columns.reduce((acc, column) => {
    acc[column.column_name] = {
      sqlType: column.udt_name,
      isNullable: column.is_nullable === 'YES'
    }

    // To get enum values in mysql and mariadb
    /* istanbul ignore next */
    if (column.udt_name === 'enum') {
      acc[column.column_name].enum = column.column_type.match(/'(.+?)'/g).map(enumValue => enumValue.slice(1, enumValue.length - 1))
    }

    if (autoTimestamp && (column.column_name === 'updated_at' || column.column_name === 'inserted_at')) {
      acc[column.column_name].autoTimestamp = true
    }
    return acc
  }, {})

  // To get enum values in pg
  /* istanbul ignore next */
  if (db.isPg) {
    const enums = await queries.listEnumValues(db, sql, table, schema)
    for (const enumValue of enums) {
      if (!fields[enumValue.column_name].enum) {
        fields[enumValue.column_name].enum = [enumValue.enumlabel]
      } else {
        fields[enumValue.column_name].enum.push(enumValue.enumlabel)
      }
    }
  }
  const currentRelations = []

  const constraintsList = await queries.listConstraints(db, sql, table, schema)
  let primaryKey

  for (const constraint of constraintsList) {
    const field = fields[constraint.column_name]

    /* istanbul ignore next */
    if (!field) {
      // This should never happen
      log.warn({
        constraint
      }, `No field for ${constraint.column_name}`)
      continue
    }

    if (constraint.constraint_type === 'PRIMARY KEY') {
      primaryKey = constraint.column_name
      // Check for SQLite typeless PK
      /* istanbul ignore next */
      if (db.isSQLite) {
        const validTypes = ['integer', 'uuid', 'serial']
        const pkType = fields[primaryKey].sqlType.toLowerCase()
        if (!validTypes.includes(pkType)) {
          throw new Error(`Invalid Primary Key type. Expected "integer", found "${pkType}"`)
        }
      }
      field.primaryKey = true
    }

    if (constraint.constraint_type === 'FOREIGN KEY') {
      field.foreignKey = true
      currentRelations.push(constraint)
    }
  }

  const entity = createMapper(db, sql, log, table, fields, primaryKey, currentRelations, queries, autoTimestamp, schema, limitConfig)
  entity.relations = currentRelations

  return entity
}

module.exports = buildEntity
