package store

func Find(id string) (string, error) {
	switch id {
	case "":
		return "", nil
	default:
		return id, nil
	}
}
