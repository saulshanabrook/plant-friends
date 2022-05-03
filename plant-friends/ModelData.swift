//
//  ModelData.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/2/22.
//

import Foundation


struct PFAFPlant: Hashable, Decodable, Identifiable {
    var latin_name: String
    var id: String {
        return self.latin_name
    }
}

typealias Response = [PFAFPlant]


let url = URL(string: "https://pfaf-data.herokuapp.com/data.json?sql=select+latin_name+from+plants+order+by+latin_name&_shape=array")!

let res = URLSession.shared
    .dataTaskPublisher(for: url)
    .tryMap() { element -> Data in
        guard let httpResponse = element.response as? HTTPURLResponse,
            httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
        return element.data
        }
    .decode(type: Response.self, decoder: JSONDecoder())
    .receive(on: RunLoop.main)


let obj = ObservableObjectPublisher(publisher: res)
