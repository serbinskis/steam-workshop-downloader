import sqlite3 from 'sqlite3';
import * as fsp from 'fs/promises';
import * as path from 'path';

export type SQLType = 'TEXT' | 'INTEGER';

export type SQLToTSType<T extends SQLType> = 
    T extends 'TEXT' ? string :
    T extends 'INTEGER' ? number :
    unknown;

export type TableColumn = {
    readonly old?: string;                      // The previous name of the column, used for renaming.
    readonly name: string;                      // The current name of the column.
    readonly type: SQLType;                     // The SQL data type ('TEXT' or 'INTEGER').
    readonly pkey?: boolean;                    // Whether this column is the primary key.
    readonly sensitive?: boolean;               // If true, this column will be excluded from .toObject(false).
    readonly default_value?: string | number;   // The default value for new rows.
};

/**
 * Defines the shape of an object that represents a single table column,
 * containing methods that can be performed on it.
 * @template TValue The TypeScript type for this specific column's value (e.g., string, number).
 * @template TSchema The full schema of the table this column belongs to.
 */
export type ColumnAction<TValue, TSchema extends TableSchema> = {
    /** The name of the column, accessible for fluent APIs. */
    readonly name: string;

    /**
     * Updates this specific column for a row identified by its primary key.
     * @param pkeyValue The primary key value of the row to update.
     * @param value The new value for this column (must match the column's type).
     * @returns An ApiResponse indicating the result of the operation.
     */
    setValue(pkeyValue: any, value: TValue): Promise<ApiResponse>;

    /**
     * Fetches all model instances where this column matches the given criteria.
     * @param value The value to search for in this column.
     * @param equality The comparison operator (e.g., '=', '>', '<', 'LIKE'). Defaults to '='.
     * @returns A promise that resolves to an array of model instances.
     */
    fetch(value: TValue, equality?: string): Promise<ModelInstance<TSchema>[]>;

    /**
     * Moves all model instances where this column matches the given criteria to another table.
     * @param to_model The destination model class.
     * @param value The value to search for in this column.
     *
     * @param equality The comparison operator (e.g., '=', '>', '<', 'LIKE'). Defaults to '='.
     * @returns An ApiResponse indicating the result of the operation.
     */
    move(to_model: ModelClass<any>, value: TValue, equality?: string): Promise<ApiResponse>;

    /**
     * Updates this column to a new value for all rows matching a condition on another column.
     * @param new_value The new value to set for this column (e.g., `access_date`).
     * @param where_column The column object to use in the WHERE clause (e.g., `this.db.models.files.columns.folder_id`).
     * @param where_value The value to match against in the WHERE clause.
     * @returns A promise with the ApiResponse, including the number of changed rows.
     */
    updateValues(new_value: TValue, where_column: ColumnAction<any, TSchema>, where_value: any): Promise<ApiResponse>;
};

export type DatabaseTables = {
    readonly [tableName: string]: readonly TableColumn[];
};

export interface DatabaseOptions<T extends DatabaseTables> {
    filename: string;                             // The path to the SQLite database file.
    error_callback?: (name: string, error: Error) => void; // A function to call when an error occurs.
    delete_unused?: boolean;                      // If true, deletes tables and collumns from the DB that are not in the schema.
    reorder?: boolean;                            // If true, reorders columns to match the schema order.
    tables?: T;                                   // The schema definition for all tables in the database.
    backup_filename?: string;                     // The filename for database backups.
    backup_interval?: number;                     // How often to run backups, in milliseconds.
    backup_enabled?: boolean;                     // Whether to enable automatic backups.
    vacuum_interval?: number;                     // How often to run VACUUM, in milliseconds.
    vacuum_enabled?: boolean;                     // Whether to enable automatic vacuuming.
}

export type TableSchema = readonly TableColumn[];

export type GenerateRowType<T extends TableSchema> = {
    [K in T[number] as K['name']]: SQLToTSType<K['type']>;
};

export type PositionalArgs<T extends TableSchema> = {
    [K in keyof T]: T[K] extends TableColumn ? SQLToTSType<T[K]['type']> : never;
};

// This defines the shape of a single model's INSTANCE
export type ModelInstance<T extends TableSchema> = GenerateRowType<T> & {
    save(): Promise<ApiResponse>;
    delete(): Promise<ApiResponse>;
    toObject(sensitive: false): Partial<GenerateRowType<T>>;
    toObject(sensitive?: true): GenerateRowType<T>;

    /**
     * Moves the database row corresponding to this instance to another table.
     * @param to_model The destination model class (e.g., this.db.models.deleted_files).
     * @returns An ApiResponse indicating the result of the operation.
     */
    move(to_model: ModelClass<any>): Promise<ApiResponse>;

    /**
     * Converts this model instance into an instance of another model.
     * This creates a new record in the target table based on this instance's data
     * and then deletes the original record.
     * @param to_model The destination model class to convert this instance to.
     * @returns A promise that resolves with the new, saved instance of the target model.
     */
    convert<U extends TableSchema>(to_model: ModelClass<U>): Promise<ModelInstance<U> | null>;
};

// This defines the shape of the model's CLASS (static side)
export type ModelClass<T extends TableSchema> = {
    new (...args: PositionalArgs<T>): ModelInstance<T>;
    fromObject(obj: GenerateRowType<T>): ModelInstance<T>;
    find(pkey: any): Promise<ModelInstance<T> | null>;
    delete(pkey: any): Promise<ApiResponse>;
    move(pkey: any, to_model: ModelClass<any>): Promise<ApiResponse>;
    all(): Promise<ModelInstance<T>[]>;
    create(...args: PositionalArgs<T>): ModelInstance<T>;
    setValue<K extends keyof GenerateRowType<T>>(field: K, value: GenerateRowType<T>[K], pkeyValue: any): Promise<ApiResponse>;
    primaryKey: string | undefined;
    tableName: string;
    columns: GenerateColumnsType<T>;
    schema: T;
};

// This creates the final type for the `models` property.
// It maps table names ("users") to capitalized class names ("User")
// and applies the correct ModelClass type.
export type GenerateModelsType<T extends DatabaseTables> = {
    [K in keyof T]: ModelClass<T[K]>;
    //[K in keyof T as Capitalize<K & string>]: ModelClass<T[K]>;
};

/**
 * Transforms a table schema into an object where keys are column names
 * and values are the action objects for that column.
 */
export type GenerateColumnsType<TSchema extends TableSchema> = {
    // This now passes the full TSchema to ColumnAction
    [K in TSchema[number] as K['name']]: ColumnAction<SQLToTSType<K['type']>, TSchema>;
};

export interface ApiResponse<T = {}> {
    code: number;
    status?: boolean;
    changes?: number;
    value?: any;
    rows?: any[];
    row?: any;
    info?: any[];
}

export default class Database<const T extends DatabaseTables> {
    public ready: boolean = false;
    public filename: string;
    public directory: string;
    public delete_unused: boolean;
    public reorder: boolean;
    public tables: DatabaseTables;
    public error_callback: (location: string, error: Error) => void;
    public busy: boolean = false;

    public backup_filename: string;
    private backup_timer: NodeJS.Timeout | number;
    public backup_interval: number;
    public backup_enabled: boolean;

    private vacuum_timer: NodeJS.Timeout | number;
    public vacuum_interval: number;
    public vacuum_enabled: boolean;

    private db: sqlite3.Database;
    public models: GenerateModelsType<T>;

    constructor(opts: DatabaseOptions<T>) {
        this.filename = opts.filename;
        this.directory = path.dirname(this.filename);
        this.delete_unused = opts.delete_unused || false;
        this.reorder = opts.reorder || false;
        this.tables = opts.tables || {};
        this.error_callback = opts.error_callback || (() => { });

        this.backup_filename = opts.backup_filename || path.format({ ...path.parse(this.filename), base: '', ext: '.db.bak' });
        this.backup_timer = -1;
        this.backup_interval = opts.backup_interval || 1000 * 60 * 60;
        this.backup_enabled = opts.backup_enabled || false;

        this.vacuum_timer = -1;
        this.vacuum_interval = opts.vacuum_interval || 1000 * 60 * 60 * 24 * 7;
        this.vacuum_enabled = opts.vacuum_enabled || false;

        this.models = {} as GenerateModelsType<T>;
        this._generateModels();
    }

    /**
     * A private method that dynamically generates and attaches model classes to the `this.models` property.
     * This method is called from the Database constructor. It iterates through the table schemas
     * provided in the options, creating a dedicated class for each table with methods to
     * create, find, save, and delete rows as object-oriented instances.
     * 
     * The generated classes are fully type-aware thanks to the generic types of the Database class.
     */
    private _generateModels() {
        const dbInstance = this;

        for (const tableName in this.tables) {
            const schema = this.tables[tableName];
            const primaryKeyColumn = schema.find(col => col.pkey)?.name;

            /**
             * Builds an object where each key is a column name and each value is an
             * object with actions for that column (e.g., setValue). This enables the
             * fluent `Model.columns.columnName.setValue(...)` API.
             */
            const columnsObject = schema.reduce((acc, column) => {
                acc[column.name] = {
                    name: column.name,
                    setValue: async (pkeyValue: any, value: any): Promise<ApiResponse> => {
                        if (!primaryKeyColumn) { throw new Error(`Cannot setValue: No primary key (pkey: true) defined for table '${tableName}'.`); }
                        return dbInstance.setValue(tableName, column.name, value, primaryKeyColumn, pkeyValue);
                    },
                    fetch: async (value: any, equality?: string): Promise<ModelInstance<typeof schema>[]> => {
                        const result = await dbInstance.getRows(tableName, column.name, value, equality); // Get all full rows that match the query using the existing getRows method.
                        return (result.rows || []).map(row => BaseModel.fromObject(row) as unknown as ModelInstance<typeof schema>); // If rows are found, map them to new model instances.
                    },
                    move: async (to_model: ModelClass<any>, value: any, equality?: string): Promise<ApiResponse> => {
                        return dbInstance.moveRows(tableName, to_model.tableName, column.name, value, equality);
                    },
                    updateValues: async (new_value: any, where_column: ColumnAction<any, typeof schema>, where_value: any): Promise<ApiResponse> => {
                        return dbInstance.setValue(tableName, column.name, new_value, where_column.name, where_value);
                    },
                };
                return acc;
            }, {} as GenerateColumnsType<typeof schema>);

            // Create a capitalized class name from the table name (e.g., "users" -> "Users").
            const className = tableName; // tableName.charAt(0).toUpperCase() + tableName.slice(1);
            type ThisModelInstance = ModelInstance<typeof schema>;

            // If no column in the schema is marked with `pkey: true`, warn the developer.
            if (!primaryKeyColumn) { console.log(`[DATABASE WARNING] Table '${tableName}' has no primary key defined, .save(), .delete(), .find(), wont work.`); }

            // Define the class for the current table.
            // This class is created within the loop's scope to capture the correct
            // `tableName`, `schema`, `primaryKeyColumn`, and `dbInstance`.
            class BaseModel {
                // A private reference to the database instance for instance methods.
                private _db: Database<T>;

                /**
                 * Creates a new instance of the model.
                 * @param args The values for the row, in the same order as the schema definition.
                 */
                constructor(...args: PositionalArgs<typeof schema>) {
                    this._db = dbInstance;
                    schema.forEach((column, index) => {
                        (this as any)[`_original_${column.name}`] = args[index]; // Store original value for save()
                        (this as any)[column.name] = args[index]; // Dynamically assign constructor arguments to instance properties.
                    });
                }

                /**
                 * Persists the current instance's data to the database.
                 * If the row's primary key already exists in the table, it performs an UPDATE.
                 * Otherwise, it performs an INSERT.
                 * @throws {Error} If the table schema does not have a primary key defined.
                 */
                async save(): Promise<ApiResponse> {
                    if (!primaryKeyColumn) { throw new Error(`Cannot save: No primary key (pkey: true) defined for table '${tableName}'.`); }

                    //Yes, we DO NOT update primary key
                    const pkValue = (this as any)[primaryKeyColumn];
                    const update = schema.filter(col => !col.pkey).filter(col => (this as any)[col.name] != (this as any)[`_original_${col.name}`]);
                    const existsResult = await this._db.valueExists(tableName, primaryKeyColumn, pkValue);

                    //If item does not exist, then just add it
                    if (!existsResult.status) {
                        const result = await this._db.addValues(tableName, ...schema.map(col => (this as any)[col.name]));
                        if (result.status) { update.forEach(col => (this as any)[`_original_${col.name}`] = (this as any)[col.name]); }
                        return result;
                    }

                    // UPDATE: The row already exists. Update each non-primary-key field.
                    const promises = update.map(col => this._db.setValue(tableName, col.name, (this as any)[col.name], primaryKeyColumn, pkValue));
                    const result = (await Promise.all(promises)).every(res => res.status);
                    if (result) { update.forEach(col => (this as any)[`_original_${col.name}`] = (this as any)[col.name]); }
                    return { code: result ? 200 : 500, status: result, changes: result ? 1 : 0 }; 
                }

                /**
                 * Deletes the row corresponding to this instance from the database.
                 * The deletion is based on the instance's primary key value.
                 * @throws {Error} If the table schema does not have a primary key defined.
                 */
                async delete(): Promise<ApiResponse> {
                    if (!primaryKeyColumn) { throw new Error(`Cannot delete: No primary key (pkey: true) defined for table '${tableName}'.`); }
                    return this._db.deleteRow(tableName, primaryKeyColumn, (this as any)[primaryKeyColumn]);
                }

                /**
                 * Moves the row corresponding to this instance to another table.
                 * The move is based on the instance's primary key value.
                 * @param to_model The destination model class.
                 * @throws {Error} If the table schema does not have a primary key defined.
                 */
                async move(to_model: ModelClass<any>): Promise<ApiResponse> {
                    if (!primaryKeyColumn) { throw new Error(`Cannot move: No primary key (pkey: true) defined for table '${tableName}'.`); }
                    return this._db.moveRows(tableName, to_model.tableName, primaryKeyColumn, (this as any)[primaryKeyColumn]);
                }

                /**
                 * Converts this model instance into an instance of another model.
                 * This function creates a new record in the target table using the current
                 * instance's data, saves it, and then deletes the original record.
                 * The schemas do not need to match perfectly.
                 * @param to_model The class of the model to convert this instance into.
                 * @returns A promise that resolves with the newly created instance of the target model or null if failed to move.
                 */
                async convert<U extends TableSchema>(to_model: ModelClass<U>): Promise<ModelInstance<U>> {
                    if (!primaryKeyColumn) { throw new Error(`Cannot convert: No primary key (pkey: true) defined for table '${tableName}'.`); }
                    const data = this.toObject(); // Get the current instance's data as a plain object.

                    // Create a new instance of the target model in memory.
                    // We use 'as any' here to satisfy TypeScript, as the source and destination schemas differ.
                    // fromObject is designed to handle this by ignoring extra fields and using defaults for missing ones.
                    const newInstance = to_model.fromObject(data as any);

                    // Save the new instance to its table in the database.
                    const saveResult = await newInstance.save();

                    // If the new instance could not be saved, abort the operation by throwing an error.
                    if (!saveResult.status) { return null; }

                    // If saving was successful, delete the original instance.
                    await this.delete();

                    // Return the new, saved instance.
                    return newInstance;
                }

                /**
                 * Converts the model instance into a plain JavaScript object.
                 * @param sensitive If true (default), includes all fields. If false, excludes fields marked as 'sensitive'.
                 * @returns A partial object representing the row's data.
                 */
                toObject(sensitive: false): Partial<GenerateRowType<typeof schema>>; // Overload: When sensitive is explicitly false, we know the object might be incomplete.
                toObject(sensitive?: true): GenerateRowType<typeof schema>; // Overload: When sensitive is true or undefined (the default), we know the object is complete.
                toObject(sensitive = true): Partial<GenerateRowType<typeof schema>> {
                    const entries = schema.filter(col => sensitive || !col.sensitive).map(col => [col.name, (this as any)[col.name]]);
                    return Object.fromEntries(entries);
                }

                /**
                 * Creates a new model instance from a plain JavaScript object.
                 * @param obj An object where keys match the column names.
                 * @returns A new instance of the model class.
                 */
                static fromObject(obj: GenerateRowType<typeof schema>) {
                    const values = schema.map(col => obj[col.name as keyof typeof obj]) as PositionalArgs<typeof schema>;
                    return new this(...values);
                }

                /**
                 * Finds a single row in the database by its primary key.
                 * @param pkey The value of the primary key to search for.
                 * @returns A model instance if found, otherwise null.
                 * @throws {Error} If the table schema does not have a primary key defined.
                 */
                static async find(pkey: any): Promise<ThisModelInstance | null> {
                    if (!primaryKeyColumn) { throw new Error(`Cannot find: No primary key (pkey: true) defined for table '${tableName}'.`); }
                    const result = await dbInstance.getRow(tableName, primaryKeyColumn, pkey);
                    if (result.row) { return this.fromObject(result.row) as unknown as ThisModelInstance; }
                    return null;
                }

                /**
                 * Deletes a single row in the database by its primary key.
                 * @param pkey The value of the primary key to delete for.
                 * @returns A api instance if found, otherwise null.
                 * @throws {Error} If the table schema does not have a primary key defined.
                 */
                static async delete(pkey: any): Promise<ApiResponse> {
                    if (!primaryKeyColumn) { throw new Error(`Cannot find: No primary key (pkey: true) defined for table '${tableName}'.`); }
                    return await dbInstance.deleteRow(tableName, primaryKeyColumn, pkey);
                }

                /**
                 * Retrieves all rows from the database table.
                 * This method fetches every record and converts each one into a model instance.
                 * @returns {Promise<ThisModelInstance[]>} A promise that resolves to an array of model instances.
                 */
                static async all(): Promise<ThisModelInstance[]> {
                    const result = await dbInstance.getRows(tableName, null, null, "*"); // Use this method on the database instance to fetch raw data.
                    return (result.rows || []).map(row => this.fromObject(row) as unknown as ThisModelInstance); // Map each raw row object to a new model instance
                }

                /**
                 * A factory method to create a new instance.
                 * @param args The values for the new row, in schema order.
                 * @returns The newly created model instance.
                 */
                static create(...args: PositionalArgs<typeof schema>): ThisModelInstance {
                    const instance = new this(...args);
                    return instance as unknown as ThisModelInstance;
                }

                /**
                 * Updates a single field for a row identified by its primary key. This is a static
                 * method that operates directly on the table without needing an instance.
                 * @param field The name of the column to update (e.g., 'filename').
                 * @param value The new value for that column.
                 * @param pkeyValue The value of the primary key to find the correct row.
                 * @returns A promise that resolves with the API response.
                 * @throws {Error} If the table schema does not have a primary key defined.
                 */
                static async setValue<K extends keyof GenerateRowType<typeof schema>>(field: K, value: GenerateRowType<typeof schema>[K], pkeyValue: any): Promise<ApiResponse> {
                    // Ensure a primary key is defined on the schema before proceeding.
                    if (!primaryKeyColumn) { throw new Error(`Cannot setValue: No primary key (pkey: true) defined for table '${tableName}'.`); }
                    return dbInstance.setValue(tableName, field as string, value, primaryKeyColumn, pkeyValue);
                }

                /**
                 * Static getter for the table name.
                 */
                static get tableName() {
                    return tableName;
                }

                /**
                 * Static getter for the primary key column name.
                 */
                static get primaryKey() {
                    return primaryKeyColumn;
                }

                /**
                 * Static getter for an object mapping column names to themselves.
                 */
                static get columns() {
                    return columnsObject;
                }

                /**
                 * Static getter for the table schema.
                 */
                static get schema() {
                    return schema;
                }
            }

            // We must cast the dynamically created class to `any` before assigning it.
            // This is a necessary compromise to bridge the gap between TypeScript's static
            // type system and the dynamic nature of this model generation. The external
            // type safety is guaranteed by the `GenerateModelsType<T>` generic on `this.models`.
            (this.models as any)[className] = BaseModel;
        }
    }

    public async close(): Promise<ApiResponse> {
        clearInterval(this.backup_timer);
        clearInterval(this.vacuum_timer);
        await this.backup(this.backup_filename);

        return new Promise(resolve => {
            this.db.close((err: Error | null) => {
                if (err) { this.error_callback('close', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: true });
            });
        });
    }

    public async open(): Promise<ApiResponse> {
        return new Promise(async (resolve) => {
            try { await fsp.mkdir(this.directory, { recursive: true }); } catch (e) {}

            this.db = new sqlite3.Database(this.filename, (sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE), async (err: Error | null) => {
                if (err) { this.error_callback('open', err); return resolve({ code: 500, status: false }); }

                for (const table in this.tables) {
                    await this.createTable(table, this.tables[table]);
                    if (this.reorder) { await this.reorderFields(table, this.tables[table]); }
                }

                for (const table of ((await this.getTables()).rows)) {
                    if (this.delete_unused && !this.tables[table]) { await this.deleteTable(table); }
                }

                this.ready = true;
                if (this.backup_enabled) { this.backup_timer = setInterval(() => this.backup(this.backup_filename), this.backup_interval); }
                if (this.vacuum_enabled) { this.vacuum_timer = setInterval(() => this.vacuum(), this.vacuum_interval); }
                resolve({ code: 200, status: true });
            });
        });
    }

    public async backup(filename?: string): Promise<ApiResponse> {
        if (this.busy) { return { code: 429, status: false }; }
        if (!filename) { filename = this.backup_filename; }
        try { await fsp.mkdir(path.dirname(filename), { recursive: true }); } catch (e) {}
        try { await fsp.unlink(filename); } catch (e) { return { code: -4082, status: false }; }
        this.busy = true;
        try { await fsp.copyFile(this.filename, filename); } catch (e) { return { code: 500, status: false }; }
        this.busy = false;
        return { code: 200, status: true };
    }

    public async vacuum(): Promise<ApiResponse> {
        if (this.busy) { return { code: 429, status: false }; }
        this.busy = true;

        const result = await new Promise<ApiResponse>(resolve => {
            this.db.run("VACUUM", (err: Error | null) => {
                if (err) { this.error_callback('vacuum', err); }
                resolve({ code: err ? 500 : 200, status: !err });
            });
        });

        this.busy = false;
        return result;
    }

    public async commit(): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.run("COMMIT", (err: Error | null) => {
                if (err) { this.error_callback('vacuum', err); }
                resolve({ code: err ? 500 : 200, status: !err });
            });
        });
    }

    public async rollback(): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.run("ROLLBACK", (err: Error | null) => {
                if (err) { this.error_callback('vacuum', err); }
                resolve({ code: err ? 500 : 200, status: !err });
            });
        });
    }

    public async createTable(table: string, fields: readonly TableColumn[]): Promise<ApiResponse> {
        return new Promise(async (resolve) => {
            const result = await this.tableExists(table);
            if (result.code != 200) { return resolve({ code: 500 }); }
            if (result.status) { return resolve(await this.addFields(table, fields, this.delete_unused)); }

            const fdefinitions = fields.map(field => `"${field.name}" ${field.type}`).join(', ');
            this.db.run(`CREATE TABLE "${table}" (${fdefinitions})`, (err: Error | null) => {
                if (err) { this.error_callback('createTable', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: true });
            });
        });
    }

    public async deleteTable(table: string): Promise<ApiResponse> {
        return new Promise(async (resolve) => {
            const result = await this.tableExists(table);
            if (result.code != 200) { return resolve({ code: 500, status: false }); }
            if (!result.status) { return resolve({ code: 404, status: false }); }

            this.db.get(`DROP TABLE "${table}"`, (err: Error | null) => {
                if (err) { this.error_callback('deleteTable', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: true });
            });
        });
    }

    public async getTableInfo(table: string): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.all(`PRAGMA table_info("${table}")`, (err: Error | null, table_fields: any[]) => {
                if (err) { this.error_callback('getTableInfo', err); return resolve({ code: 500, info: [] }); }
                return resolve({ code: 200, info: table_fields });
            });
        });
    }

    public async getTables(): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.all(`SELECT name FROM sqlite_master WHERE type='table'`, (err: Error | null, rows: {name: string}[]) => {
                if (err) { this.error_callback('getTables', err); return resolve({ code: 500, status: false, rows: [] }); }
                resolve({ code: 200, status: true, rows: rows.map(row => row.name) });
            });
        });
    }

    public async renameTable(old_table: string, new_table: string): Promise<ApiResponse> {
        const result1 = (await this.tableExists(old_table));
        if (!result1.status) { return { code: ((result1.code == 200) ? 404 : 500), status: false }; }

        const result2 = (await this.tableExists(new_table));
        if ((result2.code != 200) || result2.status) { return { code: ((result1.code == 200) ? 409 : 500), status: false }; }

        return new Promise(resolve => {
            this.db.run(`ALTER TABLE "${old_table}" RENAME TO "${new_table}"`, (err: Error | null) => {
                if (err) { this.error_callback('renameTable', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: true });
            });
        });
    }

    public async tableExists(table: string): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [table], (err: Error | null, db_table: any) => {
                if (err) { this.error_callback('tableExists', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: db_table ? true : false });
            });
        });
    }

    public async addField(table: string, field: string, type: string, default_value?: any): Promise<ApiResponse> {
        const result = await new Promise<ApiResponse>(resolve => {
            this.db.run(`ALTER TABLE "${table}" ADD COLUMN "${field}" ${type}`, (err: Error | null) => {
                if (err) { this.error_callback('addField', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: true });
            });
        });

        if ((default_value == null) || result.code != 200) { return result; }

        return await new Promise(resolve => {
            this.db.run(`UPDATE "${table}" SET "${field}"=?`, default_value, (err: Error | null) => {
                if (err) { this.error_callback('addField', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: true });
            });
        });
    };

    public addFields(table: string, fields: readonly TableColumn[], delete_unused: boolean): Promise<ApiResponse> {
        return new Promise(async (resolve) => {
            for (const field of fields) {
                if (!field.old) { continue; }
                const result = await this.renameField(table, field.old, field.name);
                if (result.code == 500) { resolve(result); }
            }

            this.db.all(`PRAGMA table_info("${table}")`, async (err: Error | null, table_fields: any[]) => {
                if (err) { this.error_callback('addFields', err); return resolve({ code: 500, status: false }); }

                const add_fields = fields.map(field => field.name);
                const db_fields = table_fields.map(field => field.name);

                const missing_fields = fields.filter(e => !db_fields.includes(e.name));
                const unused_fields = db_fields.filter(e => !add_fields.includes(e));

                if (missing_fields.length != 0) {
                    for (const field of missing_fields) {
                        const result = await this.addField(table, field.name, field.type, field.default_value);
                        if (result.code != 200) { resolve(result); }
                    }
                }

                if (delete_unused && (unused_fields.length != 0)) {
                    for (const field of unused_fields) {
                        const result = await this.deleteField(table, field);
                        if (result.code != 200) { resolve(result); }
                    }
                }

                resolve({ code: 200, status: true });
            });
        });
    };

    public async deleteField(table: string, field: string): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.run(`ALTER TABLE "${table}" DROP COLUMN "${field}"`, (err: Error | null) => {
                if (err) { this.error_callback('deleteField', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: true });
            });
        });
    };

    public async renameField(table: string, old_field: string, new_field: string): Promise<ApiResponse> {
        const result1 = (await this.fieldExists(table, old_field));
        if (!result1.status) { return { code: ((result1.code == 200) ? 404 : 500), status: false }; }

        const result2 = (await this.fieldExists(table, new_field));
        if ((result2.code != 200) || result2.status) { return { code: ((result1.code == 200) ? 409 : 500), status: false }; }

        return new Promise(resolve => {
            this.db.run(`ALTER TABLE "${table}" RENAME COLUMN "${old_field}" TO "${new_field}"`, (err: Error | null) => {
                if (err) { this.error_callback('renameField', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: true });
            });
        });
    };

    public async reorderFields(table: string, fields: readonly TableColumn[]): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.all(`PRAGMA table_info("${table}")`, async (err: Error | null, table_fields: any[]) => {
                if (err) { this.error_callback('reorderFields', err); return resolve({ code: 500, status: false }); }
                const match = fields.every((e, i) => table_fields[i].name == e.name);
                if (match) { return resolve({ code: 200, status: false }); }
                
                const rand_id = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
                
                const db_fields = fields.map(e => {
                    const index = table_fields.findIndex(field => field.name == e.name);
                    return index != -1 ? table_fields.splice(index, 1)[0] : null;
                }).concat(table_fields);

                await this.deleteTable(`temp_${rand_id}`);

                let result = await this.createTable(`temp_${rand_id}`, db_fields);
                if (result.code != 200) { return resolve(result); }

                result = await new Promise(resolve1 => {
                    this.db.run(`INSERT INTO "temp_${rand_id}" SELECT ${db_fields.map(e => e.name).join(', ')} FROM "${table}"`, (err: Error | null) => {
                        if (err) { this.error_callback('reorderFields', err); return resolve1({ code: 500 }); }
                        resolve1({ code: 200 });
                    });
                });

                if (result.code != 200) { return resolve({ code: result.code, status: false }); }

                result = await this.deleteTable(table);
                if (result.code != 200) { return resolve({ code: result.code, status: false }); }

                result = await this.renameTable(`temp_${rand_id}`, table);
                if (result.code != 200) { return resolve({ code: result.code, status: false }); }

                return resolve({ code: 200, status: true });
            });
        });
    };

    public async fieldExists(table: string, field: string): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.all(`PRAGMA table_info("${table}")`, (err: Error | null, table_fields: any[]) => {
                if (err) { this.error_callback('fieldExists', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: table_fields.some(e => e.name == field) });
            });
        });
    };

    public async addValues(table: string, ...args: any[]): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.run(`INSERT INTO "${table}" VALUES(${Array(args.length).fill('?').join(',')})`, args, (err: Error | null) => {
                if (err) { this.error_callback('addValues', err); return resolve({ code: 500 }); }
                resolve({ code: 200, status: true, changes: 1 });
            });
        });
    };

    public async getValue(table: string, field: string, value: any, search_field: string, equality?: string): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.get(`SELECT "${search_field}" FROM "${table}" WHERE "${field}"${equality ? equality : '='}? LIMIT 1`, [value], (err: Error | null, row: any) => {
                if (err) { this.error_callback('getValue', err); return resolve({ code: 500, value: null }); }
                resolve({ code: 200, value: row ? row[search_field] : null });
            });
        });
    };

    public async setValue(table: string, field: string, value: any, search_field: string, search_value: any): Promise<ApiResponse> {
        return new Promise(resolve => {
            var that = this;
            this.db.run(`UPDATE "${table}" SET "${field}"=? WHERE "${search_field}"=?`, [value, search_value], function (this: sqlite3.RunResult, err: Error | null) {
                if (err) { that.error_callback('setValue', err); return resolve({ code: 500, status: false, changes: 0 }); }
                resolve({ code: 200, status: (this.changes > 0), changes: this.changes });
            });
        });
    };

    public async valueExists(table: string, field: string, value: any, equality?: string): Promise<ApiResponse> {
        return new Promise(resolve => {
            this.db.get(`SELECT "${field}" FROM "${table}" WHERE "${field}"${equality ? equality : '='}? LIMIT 1`, [value], (err: Error | null, row: any) => {
                if (err) { this.error_callback('valueExists', err); return resolve({ code: 500, status: false }); }
                resolve({ code: 200, status: row ? true : false });
            });
        });
    };

    public async getRow(table: string, field: string, value: any, equality?: string): Promise<ApiResponse> {
        const result = await this.getRows(table, field, value, equality, 1);
        return { code: result.code, row: (result.rows?.[0]) || null };
    };

    /**
     * Retrieves rows from a specified table based on a condition.
     * Can fetch all rows if the equality operator '*' is used.
     * @param {string} table The name of the table to query.
     * @param {string} field The column to check. Ignored if equality is '*'.
     * @param {any} value The value to match against. Ignored if equality is '*'.
     * @param {string} [equality='='] The comparison operator. ("=", ">", "<", "<>")
     * @param {number} [limit] An optional limit for the number of rows to return.
     * @returns {Promise<ApiResponse>} A promise that resolves with an ApiResponse containing the matching rows.
     */
    public async getRows(table: string, field: string, value: any, equality?: string, limit?: number): Promise<ApiResponse> {
        return new Promise(resolve => {
            const whereClause = (equality === '*') ? '' : ` WHERE "${field}" ${equality || '='} ?`;
            const limitClause = (limit != null && limit >= 0) ? ` LIMIT ${limit}` : '';
            const query = `SELECT * FROM "${table}"${whereClause}${limitClause}`;

            this.db.all(query, (equality === '*' ? [] : [value]), (err: Error | null, rows: any[]) => {
                if (err) { this.error_callback('getRows', err); return resolve({ code: 500, rows: null }); }
                resolve({ code: 200, rows: rows ? rows : null });
            });
        });
    };

    public async deleteRow(table: string, field: string, value: any, equality?: string): Promise<ApiResponse> {
        return await this.deleteRows(table, field, value, equality, 1);
    };

    public async deleteRows(table: string, field: string, value: any, equality?: string, limit?: number): Promise<ApiResponse> {
        return new Promise(resolve => {
            var that = this;
            this.db.run(`DELETE FROM "${table}" WHERE rowid IN (SELECT rowid FROM "${table}" WHERE "${field}"${equality ? equality : '='}?${limit >= 0 ? ` LIMIT ${limit}` : ''})`, [value], function (this: sqlite3.RunResult, err: Error | null) {
                if (err) { that.error_callback('deleteRows', err); return resolve({ code: 500, status: false, changes: 0 }); }
                resolve({ code: 200, status: (this.changes > 0), changes: this.changes });
            });
        });
    };

    public async moveRows(from_table: string, to_table: string, field: string, value: any, equality?: string, limit?: number): Promise<ApiResponse> {
        const result = await new Promise<ApiResponse>(resolve => {
            var that = this;
            this.db.run(`INSERT INTO "${to_table}" SELECT * FROM "${from_table}" WHERE "${field}"${equality ? equality : '='}?${limit >= 0 ? ` LIMIT ${limit}` : ''}`, [value], function (this: sqlite3.RunResult, err: Error | null) {
                if (err) { that.error_callback('moveRows', err); return resolve({ code: 500, status: false, changes: 0 }); }
                resolve({ code: 200, status: (this.changes > 0), changes: this.changes });
            });
        });

        if (result.code != 200) { return result; }
        return await this.deleteRows(from_table, field, value, equality, limit);
    };

    public runQuery(...args: any[]): sqlite3.Database {
        return this.db.run(...(args as [string, ...any[]]));
    };

    public getQuery(...args: any[]): sqlite3.Database {
        return this.db.get(...(args as [string, ...any[]]));
    };

    public allQuery(...args: any[]): sqlite3.Database {
        return this.db.all(...(args as [string, ...any[]]));
    };
}