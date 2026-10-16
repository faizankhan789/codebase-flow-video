class Job
  def perform(id)
    record = load(id)
    notify(record) if record
  end
  def load(id); id; end
  def notify(r); r; end
end
