class Db {
  async saveOrder(order) {
    return this.insert('orders', order);
  }
  async insert(table, row) { return { table, row }; }
}
module.exports = new Db();
