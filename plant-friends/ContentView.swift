//
//  ContentView.swift
//  plant-friends
//
//  Created by Saul Shanabrook on 5/1/22.
//

import SwiftUI

struct ContentView: View {
    @StateObject var resp = obj;
    var body: some View {
        NavigationView{
            List(resp.value ?? [PFAFPlant(latin_name: "Loading...")]) { plant in
                NavigationLink {
                    DetailView(plant: plant)
                } label: {
                    Text(plant.latin_name)
                }
            }.navigationTitle("Plants")
        }
    }
}

struct ContentView_Previews: PreviewProvider {
    static var previews: some View {
        ContentView()
    }
}
